// 数据获取层：从 zen-fs-config 的 dir-struct-gen 数据组读取目录结构清单。
// 复用配置面板（zen-fs-config-ui）里配置的同步后端（RemoteStorage / Gitee …），
// 不再直连 onenav 账号的 RemoteStorage、也不再维护基目录前缀。
//
// 存储模型（dir-struct-manifest-format.md v2）。路径相对数据组逻辑根，
// 后端自己的基准路径在后端配置里指定：
//   /struct/<host>.json                   — 主机索引 { version:2, source, mounts:[{volumeId,files:[<基名>]}] }
//   /struct/<volumeId>.<createdAt>.json   — 某块盘「按次生成」的卷子树（每次生成一份，互不覆盖）
//   /struct/<volumeKey>.json              — 旧版单文件卷（历史数据，仍兼容）
//   /folder-deepen/<key>.json             — 深挖标记 { marks:[ "E:/Photos/2024", ... ] }
//   /file-tags/<key>.json                 — 用户标签 { tags:{ "E:/Photos/2024": ["旅行","2024"] } }
// 其中 volumeKey = 卷的 .dir-struct-id（UUID，跨主机一致）。
// 读取侧：对主机索引的每个 mount 取该卷全部分片（files 优先，回退 file），按 volumeId 合并成一棵树。
// 合并规则见 ./merge.ts（严格对齐生成器与格式文档「分片合并规则」）。
//
// 兼容：仍支持 v1 单文件整树清单（含 root 字段，无 mounts）。
//
// 本读取侧把上述结构「拼装」回 { root, source, ... } 形态（与 normalize 输入一致），
// 因此对 FileBrowserApp / normalize 其余逻辑透明。

import { getDirStructGroup } from '@/lib/dir-struct-group'
import { isRemoteStorageAuthError } from '@/lib/remotestorage-connection'
import { mergeShards } from './merge'
import type { RawManifest } from './types'

/** 数据组未连接（无活动组 / 无 fs 视图） */
export class RsNotConnectedError extends Error {
  code = 'NOT_CONNECTED'
  constructor(message = '未连接数据同步组') {
    super(message)
    this.name = 'RsNotConnectedError'
  }
}

/** 鉴权失败（401/403），需要重新检查后端凭据 */
export class RsAuthError extends Error {
  code = 'AUTH'
  constructor(message = '数据同步组鉴权失败') {
    super(message)
    this.name = 'RsAuthError'
  }
}

// 数据组内子目录：清单在 struct/，深挖标记在 folder-deepen/，用户标签在 file-tags/。
const STRUCT_DIR = '/struct'
const DEEPEN_DIR = '/folder-deepen'
const FILE_TAGS_DIR = '/file-tags'

/** 未索引卷（分片存在但无主机索引引用它们）的合成主机名 */
const ORPHAN_SOURCE = '（未索引卷）'

/** 读权限不足时的错误说明：已连接后端，但当前凭据缺目录权限（服务端 401/403） */
const FOLDERS_AUTH_MSG =
  '同步后端已连接，但凭据缺少对应目录的权限（服务端 401/403）。' +
  '请在下方同步组面板检查后端地址与 token 后重试。'

// RemoteStorage 路径只允许安全字符，其余替换为下划线（与 dir-struct-gen 的 sanitizeKey 一致）。
function sanitizeKey(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 数据组 fs.promises 的最小形状 */
interface GroupPromisesFs {
  readFile(path: string, encoding?: string): Promise<any>
  writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>
  readdir(path: string): Promise<string[]>
}

/** 取活动数据组的文件视图；未连接则抛 RsNotConnectedError。 */
function getFs(): GroupPromisesFs {
  const group = getDirStructGroup()
  const p = (group as any)?.fs?.promises as GroupPromisesFs | undefined
  if (!p) throw new RsNotConnectedError()
  return p
}

/** 列出目录条目，兼容条目为字符串或 { name } 对象；统一去掉 ./ 前缀。 */
async function listNames(fs: GroupPromisesFs, dir: string): Promise<string[]> {
  let entries: string[] = []
  for (const d of [dir, `${dir}/`]) {
    try {
      const list = await fs.readdir(d)
      if (list.length > 0) {
        entries = list
        break
      }
    } catch {
      // 目录不存在 / 后端差异：换带斜杠的写法再试；最终空列表 → 空态
    }
  }
  return entries.map((e) => (typeof e === 'string' ? e : String((e as any)?.name ?? e)))
}

/** 从主机索引的一个 mount 项取该卷全部分片基名（files 优先、回退 file），稳定排序 */
function mountShardBases(mount: Record<string, unknown>): string[] {
  const fromFiles = Array.isArray(mount.files)
    ? (mount.files as unknown[])
        .map((f) => (typeof f === 'string' ? f : f && typeof f === 'object' ? (f as Record<string, unknown>).file : null))
        .filter((b): b is string => typeof b === 'string' && !!b)
    : []
  const bases =
    fromFiles.length > 0
      ? fromFiles
      : typeof mount.file === 'string' && mount.file
        ? [mount.file]
        : []
  // 固定折叠顺序 → 合并结果确定（与生成器 applyLoadedDoc 同一口径）
  return [...new Set(bases)].sort((a, b) => a.localeCompare(b))
}

/**
 * 列出并读取 /struct/ 下全部 .json，按形态分类拼装为原始清单数组：
 * - 含 mounts 数组 → 主机索引：对每个 mount 取该卷全部分片并合并成一棵树；
 * - 含 volumeId + children 且非 root/mounts → 卷分片，收入按基名的映射，等待被主机索引合并；
 * - 含 root 字段 → legacy v1 整树清单，原样透传。
 * 未被任何主机索引引用的分片，按 volumeId 归组后合并，作为「未索引卷」展示（不丢数据）。
 *
 * 单文件解析/读取失败会被跳过，不导致整页崩溃。
 */
export async function fetchDirStructManifests(): Promise<RawManifest[]> {
  const fs = getFs()

  const names = (await listNames(fs, STRUCT_DIR)).map((n) => n.replace(/^\.\//, ''))
  const jsonNames = names.filter((n) => n.endsWith('.json'))

  // 读取全部 json 文件（保留去掉 .json 的基名，供 mounts 按基名引用分片）
  const docs: { base: string; raw: Record<string, unknown> }[] = []
  for (const n of jsonNames) {
    const p = `${STRUCT_DIR}/${n}`
    try {
      const text = await fs.readFile(p, 'utf8')
      try {
        const raw = JSON.parse(text) as Record<string, unknown>
        if (raw && typeof raw === 'object') docs.push({ base: n.replace(/\.json$/, ''), raw })
      } catch {
        console.warn('[filebrowser] 清单解析失败，已跳过:', p)
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
      console.warn('[filebrowser] 清单读取失败，已跳过:', p, e)
    }
  }

  // 分类
  const hostIndexes: Record<string, unknown>[] = []
  const shardByBase = new Map<string, Record<string, unknown>>()
  const legacy: Record<string, unknown>[] = []
  for (const d of docs) {
    const raw = d.raw
    if (Array.isArray(raw.mounts)) {
      hostIndexes.push(raw)
    } else if ('volumeId' in raw && Array.isArray(raw.children) && !raw.root) {
      // 卷分片 / 旧版单文件卷：都按基名收好，等待被主机索引引用后合并
      shardByBase.set(d.base, raw)
    } else if (raw.root && typeof raw.root === 'object') {
      legacy.push(raw)
    }
    // 其余形态：跳过
  }

  const out: RawManifest[] = []
  // legacy v1：原样透传
  for (const l of legacy) out.push(l)

  // 主机索引：对每个 mount 取该卷全部分片 → 合并成一棵树 → 挂在该主机根下
  const referencedBases = new Set<string>()
  for (const hi of hostIndexes) {
    const source = typeof hi.source === 'string' ? hi.source : 'unknown'
    const drives: Record<string, unknown>[] = []
    const mounts = Array.isArray(hi.mounts) ? (hi.mounts as unknown[]) : []
    for (const m of mounts) {
      if (!m || typeof m !== 'object') continue
      const mount = m as Record<string, unknown>
      const bases = mountShardBases(mount)
      if (!bases.length) continue
      for (const b of bases) referencedBases.add(b)
      const docsForMount = bases
        .map((b) => shardByBase.get(b))
        .filter((x): x is Record<string, unknown> => !!x)
      if (!docsForMount.length) continue
      const merged = mergeShards(docsForMount)
      if (!merged) continue
      // 驱动节点：以 mount.letter 为名，保留合并后的统计字段 / sources / volumeId。
      const drive: Record<string, unknown> = { ...merged }
      drive.type = 'folder'
      if (typeof mount.letter === 'string' && mount.letter) drive.name = mount.letter
      if (!drive.volumeId && typeof mount.volumeId === 'string' && mount.volumeId) {
        drive.volumeId = mount.volumeId
      }
      drives.push(drive)
    }
    // 盘符顺序：按名称自然排序，保证多主机展示稳定
    drives.sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true }),
    )
    out.push({
      source,
      generatedAt: typeof hi.generatedAt === 'string' ? hi.generatedAt : undefined,
      generator: typeof hi.generator === 'string' ? hi.generator : undefined,
      root: { name: source, type: 'folder', children: drives },
    })
  }

  // 未被任何主机索引引用的分片：按 volumeId 归组后合并，作为「未索引卷」展示（不丢数据）。
  const orphanGroups = new Map<string, Record<string, unknown>[]>()
  for (const [base, raw] of shardByBase) {
    if (referencedBases.has(base)) continue
    const vid = typeof raw.volumeId === 'string' && raw.volumeId ? raw.volumeId : ''
    const groupKey = vid || `∅::${typeof raw.name === 'string' ? raw.name : base}`
    const arr = orphanGroups.get(groupKey) ?? []
    arr.push(raw)
    orphanGroups.set(groupKey, arr)
  }
  if (orphanGroups.size > 0) {
    const orphanDrives: Record<string, unknown>[] = []
    for (const [, groupDocs] of orphanGroups) {
      const merged = mergeShards(groupDocs)
      if (!merged) continue
      const drive: Record<string, unknown> = { ...merged, type: 'folder' }
      if (typeof drive.name !== 'string') drive.name = '（未命名卷）'
      orphanDrives.push(drive)
    }
    orphanDrives.sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true }),
    )
    if (orphanDrives.length > 0) {
      out.push({
        source: ORPHAN_SOURCE,
        generatedAt: undefined,
        generator: undefined,
        root: { name: ORPHAN_SOURCE, type: 'folder', children: orphanDrives },
      })
    }
  }

  return out
}

/**
 * 读取某块盘的深挖标记（/folder-deepen/<key>.json）。
 * 404 / 解析失败 / 未连接 → 返回空数组（不抛错，避免阻断浏览）。
 */
export async function getFolderDeepenMarks(key: string): Promise<string[]> {
  try {
    const fs = getFs()
    const p = `${DEEPEN_DIR}/${sanitizeKey(key)}.json`
    const text = await fs.readFile(p, 'utf8')
    try {
      const obj = JSON.parse(text)
      if (obj && Array.isArray(obj.marks)) {
        return (obj.marks as unknown[]).filter((m): m is string => typeof m === 'string')
      }
      return []
    } catch {
      return []
    }
  } catch (e) {
    if (isRemoteStorageAuthError(e)) {
      // 权限问题仅告警，不打断浏览
      console.warn('[filebrowser] 读取深挖标记权限不足:', e)
    }
    return []
  }
}

/**
 * 写回某块盘的深挖标记（/folder-deepen/<key>.json）。
 * 权限错误（401/403）抛 RsAuthError，由调用方提示检查后端；其它错误原样抛出。
 */
export async function putFolderDeepenMarks(key: string, paths: string[]): Promise<void> {
  const fs = getFs()
  const p = `${DEEPEN_DIR}/${sanitizeKey(key)}.json`
  try {
    await fs.writeFile(p, JSON.stringify({ marks: paths }))
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
    throw e
  }
}

/** 某块盘的用户标签映射：host-relative 路径（盘符开始、/ 连接）→ 标签数组 */
export type FileTagsMap = Record<string, string[]>

/**
 * 读取某块盘的用户标签（/file-tags/<key>.json）。
 * 404 / 解析失败 / 未连接 → 返回空对象（不抛错，避免阻断浏览）。
 */
export async function getFileTags(key: string): Promise<FileTagsMap> {
  try {
    const fs = getFs()
    const p = `${FILE_TAGS_DIR}/${sanitizeKey(key)}.json`
    const text = await fs.readFile(p, 'utf8')
    try {
      const obj = JSON.parse(text)
      const rawTags = obj && typeof obj === 'object' ? (obj.tags as unknown) : null
      if (!rawTags || typeof rawTags !== 'object' || Array.isArray(rawTags)) return {}
      const out: FileTagsMap = {}
      for (const [path, value] of Object.entries(rawTags as Record<string, unknown>)) {
        if (!path || !Array.isArray(value)) continue
        const tags = value.filter((t): t is string => typeof t === 'string' && !!t)
        if (tags.length) out[path] = tags
      }
      return out
    } catch {
      return {}
    }
  } catch (e) {
    if (isRemoteStorageAuthError(e)) {
      // 权限问题仅告警，不打断浏览
      console.warn('[filebrowser] 读取用户标签权限不足:', e)
    }
    return {}
  }
}

/**
 * 写回某块盘的用户标签（/file-tags/<key>.json）。
 * 权限错误（401/403）抛 RsAuthError，由调用方提示检查后端；其它错误原样抛出。
 */
export async function putFileTags(key: string, map: FileTagsMap): Promise<void> {
  const fs = getFs()
  const p = `${FILE_TAGS_DIR}/${sanitizeKey(key)}.json`
  try {
    await fs.writeFile(p, JSON.stringify({ tags: map }))
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
    throw e
  }
}
