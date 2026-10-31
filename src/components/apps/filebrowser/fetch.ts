// 数据获取层：从 onenav 同账号 RemoteStorage 读取目录结构清单。
// 复用 onenav 现有 OAuth 连接（Q1=A），无需额外配置。
//
// 存储模型（dir-struct-manifest-format.md v2）：
//   app_data/folders/<host>.json             — 主机索引 { version:2, source, mounts:[{letter,volumeId,file,files:[{file,partId}]}] }
//   app_data/folders/<volumeKey>.<partId>.json — 某块盘「按主机分片」的卷子树（每台主机一份，互不覆盖）
//   app_data/folders/<volumeKey>.json        — 旧版单文件卷（历史数据，仍兼容）
//   app_data/folder-deepen/<key>.json        — 深挖标记 { marks:[ "E:/Photos/2024", ... ] }
// 其中 volumeKey = 卷的 .dir-struct-id（UUID，跨主机一致）。
// 读取侧：对主机索引的每个 mount 取该卷全部分片（files 优先，回退 file），按 volumeId 合并成一棵树。
// 合并规则见 ./merge.ts（严格对齐生成器与格式文档「分片合并规则」）。
//
// 兼容：仍支持 v1 单文件整树清单（含 root 字段，无 mounts）。
//
// 本读取侧把上述结构「拼装」回 { root, source, ... } 形态（与 normalize 输入一致），
// 因此对 FileBrowserApp / normalize 其余逻辑透明。

import { RemoteStorageFileSystem } from '@/lib/remotestorage-fs'
import {
  claimAccess,
  getStorageCredentials,
  getSavedStorageCredentials,
  isRemoteStorageAuthError,
} from '@/lib/remotestorage-connection'
import { mergeShards } from './merge'
import type { RawManifest } from './types'

/** 未连接 RemoteStorage（无凭据） */
export class RsNotConnectedError extends Error {
  code = 'NOT_CONNECTED'
  constructor(message = '未连接 RemoteStorage') {
    super(message)
    this.name = 'RsNotConnectedError'
  }
}

/** 鉴权失败（401/403），需要重新连接 */
export class RsAuthError extends Error {
  code = 'AUTH'
  constructor(message = 'RemoteStorage 鉴权失败') {
    super(message)
    this.name = 'RsAuthError'
  }
}

// 目录结构清单默认存储目录（与 dir-struct-manifest-format.md 的 rsBase 默认值一致）。
const FOLDERS_DIR = 'app_data/folders'
const DEEPEN_DIR = 'app_data/folder-deepen'

/** 未索引卷（分片存在但无主机索引引用它们）的合成主机名 */
const ORPHAN_SOURCE = '（未索引卷）'

/** app_data 读权限不足时的错误说明：已连接，但当前令牌缺作用域，需断开重连换取新令牌 */
const FOLDERS_AUTH_MSG =
  'RemoteStorage 已连接，但当前令牌缺少 app_data 目录的权限（服务端 401）。' +
  '请在主页断开 RemoteStorage 并重新连接一次以授予该权限。'

// RemoteStorage 路径只允许安全字符，其余替换为下划线（与 dir-struct-gen 的 sanitizeKey 一致）。
function sanitizeKey(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 构建一个 RS 文件系统实例；未连接则抛 RsNotConnectedError */
function getFS(): RemoteStorageFileSystem {
  const credentials = getStorageCredentials() || getSavedStorageCredentials()
  if (!credentials) throw new RsNotConnectedError()
  return new RemoteStorageFileSystem({ href: credentials.href, token: credentials.token })
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
 * 列出并读取 app_data/folders/ 下全部 .json，按形态分类拼装为原始清单数组：
 * - 含 mounts 数组 → 主机索引：对每个 mount 取该卷全部分片并合并成一棵树；
 * - 含 volumeId + children 且非 root/mounts → 卷分片，收入按基名的映射，等待被主机索引合并；
 * - 含 root 字段 → legacy v1 整树清单，原样透传。
 * 未被任何主机索引引用的分片，按 volumeId 归组后合并，作为「未索引卷」展示（不丢数据）。
 *
 * 单文件解析/读取失败会被跳过，不导致整页崩溃。
 */
export async function fetchDirStructManifests(): Promise<RawManifest[]> {
  // best-effort：登记 app_data 读写权限（供后续重新授权时带上 scope）
  try {
    claimAccess('app_data', 'rw')
  } catch {
    // 忽略：claim 失败不应阻断读取
  }

  const fs = getFS()

  // 清掉目录列表缓存，确保本次能枚举到最新远端的 app_data/folders 结构。
  try {
    await fs.invalidateDirListing()
  } catch (e) {
    console.warn('[filebrowser] 清除 app_data/folders 目录缓存失败（已忽略）:', e)
  }

  // readdir 对结尾斜杠的要求因服务器而异：先试无斜杠，再试有斜杠。
  let names: string[] = []
  for (const dir of [FOLDERS_DIR, `${FOLDERS_DIR}/`]) {
    try {
      const list = await fs.readdir(dir)
      if (list.length > 0) {
        names = list
        break
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
      // 否则忽略，尝试带斜杠；目录不存在也会走到这里，最终得到空列表 → 空态
    }
  }

  const jsonNames = names
    .map((n) => n.replace(/^\.\//, '')) // zen-fs 可能返回带 ./ 前缀的条目
    .filter((n) => n.endsWith('.json'))

  // 读取全部 json 文件（保留去掉 .json 的基名，供 mounts 按基名引用分片）
  const docs: { base: string; raw: Record<string, unknown> }[] = []
  for (const n of jsonNames) {
    const p = `${FOLDERS_DIR}/${n}`
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
 * 读取某块盘的深挖标记（app_data/folder-deepen/<key>.json）。
 * 404 / 解析失败 / 未连接 → 返回空数组（不抛错，避免阻断浏览）。
 */
export async function getFolderDeepenMarks(key: string): Promise<string[]> {
  try {
    const fs = getFS()
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
      return []
    }
    return []
  }
}

/**
 * 写回某块盘的深挖标记（app_data/folder-deepen/<key>.json）。
 * 权限错误（401）抛 RsAuthError，由调用方提示去重连；其它错误原样抛出。
 */
export async function putFolderDeepenMarks(key: string, paths: string[]): Promise<void> {
  const fs = getFS()
  const p = `${DEEPEN_DIR}/${sanitizeKey(key)}.json`
  try {
    await fs.writeFile(p, JSON.stringify({ marks: paths }))
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
    throw e
  }
}
