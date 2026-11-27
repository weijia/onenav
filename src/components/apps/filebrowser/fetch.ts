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

import { getDirStructGroup, isDirStructGroupReady, attachDirStructGroup } from '@/lib/dir-struct-group'
import { groupHasPath } from '@/lib/fs-config-backends'
import type { AppDataGroup } from 'zen-fs-config'
import { isRemoteStorageAuthError } from '@/lib/remotestorage-connection'
import { mergeShards } from './merge'
import type { RawManifest } from './types'
import { appendTagDiff, readShardedMap, safeKey } from './sharded-tags'

/** 空清单重试轮数与间隔：等待后台同步把远端分片拉进本地缓存。 */
const RETRY_ROUNDS = 4
const RETRY_INTERVAL_MS = 1200

/** 冷启动等待同步组连接的窗口：首次连接要拉配置仓，实测常需 10–30s。 */
const READY_WAIT_MS = 35_000
const READY_POLL_MS = 500

/** 模块加载标记（用于确认线上跑的是这份读侧代码） */
try {
  if (typeof window !== 'undefined') {
    ;(window as any).__fbModule = 'fetch-diag-v3'
    // 同时写入 localStorage：页面 JS 与调试探针可能不在同一执行世界，localStorage 是共享的
    localStorage.setItem('fbModule', 'fetch-diag-v3')
  }
} catch {
  /* ignore */
}

/** 诊断日志：写入 window.__fbDiag，便于在页面里直接读（临时，定位完可删）。 */
function fbDiag(step: string, data?: Record<string, unknown>): void {
  try {
    if (typeof window === 'undefined') return
    const w = window as any
    w.__fbDiag = w.__fbDiag || []
    w.__fbDiag.push({ t: Date.now(), step, ...(data || {}) })
    if (w.__fbDiag.length > 300) w.__fbDiag.shift()
    // 落一份到 localStorage：读侧日志要在页面世界之外也能取到
    localStorage.setItem('fbDiag', JSON.stringify(w.__fbDiag.slice(-120)))
  } catch {
    /* ignore */
  }
}

/** 把错误压成可读字符串（含 zen-fs 的 code / errno） */
function errBrief(e: unknown): Record<string, unknown> {
  const anyE = e as any
  return {
    msg: anyE instanceof Error ? `${anyE.name}: ${anyE.message}` : String(e),
    code: anyE?.code,
    errno: anyE?.errno,
    path: anyE?.path,
    name: anyE?.name,
    syscall: anyE?.syscall,
  }
}

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
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: any): Promise<any>
}

/** 取活动数据组的文件视图；未连接则抛 RsNotConnectedError。 */
function getFs(): GroupPromisesFs {
  const group = getDirStructGroup()
  const p = (group as any)?.fs?.promises as GroupPromisesFs | undefined
  fbDiag('getFs', {
    hasGroup: !!group,
    groupId: (group as any)?.groupId,
    appId: (group as any)?.appId,
    instanceId: (group as any)?.instanceId,
    hasFs: !!(group as any)?.fs,
    fsCtor: (group as any)?.fs?.constructor?.name,
    hasPromises: !!p,
    keys: group ? Object.keys(group as any).slice(0, 25) : undefined,
  })
  if (!p) throw new RsNotConnectedError()
  return p
}

/**
 * 以 UTF-8 读文本。
 *
 * 注意：数据组本地后端的 readFile 只认 `'utf-8'` 这个编码串（见 zen-fs-config
 * backend-registry：`args[0] === 'utf-8'` 才解码）；传 `'utf8'` 会原样返回
 * Uint8Array，随后 JSON.parse 必然抛错，整个 /struct 会被当成"没有清单"。
 * 这里统一走 'utf-8'，并再兜一层 Uint8Array 解码。
 */
async function readText(fs: GroupPromisesFs, path: string): Promise<string> {
  const data = await fs.readFile(path, 'utf-8')
  if (typeof data === 'string') return data
  try {
    const u8 =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data as any)
    return new TextDecoder('utf-8').decode(u8)
  } catch {
    return String(data)
  }
}

/** 列出目录条目，兼容条目为字符串或 { name } 对象；统一去掉 ./ 前缀。 */
async function listNames(fs: GroupPromisesFs, dir: string): Promise<string[]> {
  let entries: string[] = []
  for (const d of [dir, `${dir}/`]) {
    try {
      const list = await fs.readdir(d)
      fbDiag('readdir-ok', { dir: d, count: list.length, sample: list.slice(0, 5) })
      if (list.length > 0) {
        entries = list
        break
      }
    } catch (e) {
      // 目录不存在 / 后端差异：换带斜杠的写法再试；最终空列表 → 空态
      fbDiag('readdir-fail', { dir: d, ...errBrief(e) })
      console.warn('[filebrowser] readdir 失败:', d, e)
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
  // 冷启动：配置仓连接 + 数据组实例化是异步的，先等它就绪再读，避免把
  // 「还在连」误报成「未连接」。
  await waitForGroupReady()
  await ensureStructSource()

  const group = getDirStructGroup()
  try {
    ;(window as any).__fbGroup = group
  } catch {
    /* ignore */
  }

  // 数据组 fs 是本地缓存层：远端文件要等初始同步（syncAll）拉到本地后才能读到。
  // 挂载组后立即读可能命中空缓存，这里先 flush() 触发一次双向同步；清单仍为空时
  // 按间隔重试几轮，等待后台轮询把远端分片补齐。
  const t0 = Date.now()
  fbDiag('flush-begin', { hasGroup: !!group })
  await flushGroup(group)
  fbDiag('flush-end', { ms: Date.now() - t0 })

  let out = await readOnce()
  fbDiag('read-round', { attempt: 0, docs: out.length })
  for (let attempt = 1; out.length === 0 && attempt < RETRY_ROUNDS; attempt++) {
    await sleep(RETRY_INTERVAL_MS)
    await flushGroup(group)
    out = await readOnce()
    fbDiag('read-round', { attempt, docs: out.length })
  }
  return out
}

/** 轮询等待数据组挂载；超时后按未连接处理（由 UI 提示重试）。 */
async function waitForGroupReady(): Promise<void> {
  const t0 = Date.now()
  if (isDirStructGroupReady()) {
    fbDiag('ready-now', { ms: 0 })
    return
  }
  fbDiag('wait-ready-begin', {})
  while (Date.now() - t0 < READY_WAIT_MS) {
    await sleep(READY_POLL_MS)
    if (isDirStructGroupReady()) {
      fbDiag('wait-ready-end', { ms: Date.now() - t0 })
      return
    }
  }
  fbDiag('wait-ready-timeout', { ms: Date.now() - t0 })
}

/**
 * 自愈：挂着的组若 /struct 为空（典型是「已删的残留组」仍被持有，或挂错了组），
 * 到配置仓里找一个 /struct 确有内容的组改挂。
 */
async function ensureStructSource(): Promise<void> {
  const current = getDirStructGroup()
  if (!current) return
  if (await groupHasPath(current, STRUCT_DIR)) return

  const repo = (current as any).parent
  if (!repo?.listAppDataGroups || !repo?.getAppDataGroup) return
  try {
    const descriptors = await repo.listAppDataGroups()
    fbDiag('self-heal-scan', {
      current: (current as any).groupId,
      groups: descriptors.map((d: any) => d.id),
    })
    for (const d of descriptors) {
      if (d.id === (current as any).groupId) continue
      const cand = await repo.getAppDataGroup(d.id)
      if (cand?.fs?.promises && (await groupHasPath(cand, STRUCT_DIR))) {
        attachDirStructGroup(cand)
        fbDiag('self-heal-rebind', { from: (current as any).groupId, to: d.id })
        return
      }
    }
  } catch (e) {
    fbDiag('self-heal-fail', errBrief(e))
  }
}

/** 触发数据组一次双向同步（pull 远端到本地缓存）；未就绪/无 flush 方法时忽略。 */
async function flushGroup(group: AppDataGroup | null): Promise<void> {  try {
    if (group && typeof group.flush === 'function') await group.flush()
  } catch (e) {
    console.warn('[filebrowser] 同步组刷新失败:', e)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 单轮读取：从本地缓存 fs 读 /struct 清单并拼装。 */
async function readOnce(): Promise<RawManifest[]> {
  const fs = getFs()

  const names = (await listNames(fs, STRUCT_DIR)).map((n) => n.replace(/^\.\//, ''))
  const jsonNames = names.filter((n) => n.endsWith('.json'))
  fbDiag('readOnce', { names: names.length, jsonNames: jsonNames.length, sample: names.slice(0, 6) })

  // 读取全部 json 文件（保留去掉 .json 的基名，供 mounts 按基名引用分片）
  const docs: { base: string; raw: Record<string, unknown> }[] = []
  for (const n of jsonNames) {
    const p = `${STRUCT_DIR}/${n}`
    try {
      const text = await readText(fs, p)
      if (docs.length < 3 && jsonNames.length > 0) {
        fbDiag('readFile-ok', {
          path: p,
          kind: typeof text,
          ctor: (text as any)?.constructor?.name,
          isArr: Array.isArray(text),
          head: typeof text === 'string' ? text.slice(0, 60) : String(text).slice(0, 60),
        })
      }
      try {
        const raw = JSON.parse(text) as Record<string, unknown>
        if (raw && typeof raw === 'object') {
          if (docs.length < 3) {
            fbDiag('doc-sample', {
              name: n,
              keys: Object.keys(raw).slice(0, 14),
              hasMounts: Array.isArray((raw as any).mounts),
              hasChildren: Array.isArray((raw as any).children),
              hasRoot: !!(raw as any).root,
              volumeId: (raw as any).volumeId,
              len: text.length,
              head: text.slice(0, 120),
            })
          }
          docs.push({ base: n.replace(/\.json$/, ''), raw })
        }
      } catch (pe) {
        fbDiag('parse-fail', {
          path: p,
          kind: typeof text,
          head: typeof text === 'string' ? text.slice(0, 60) : String(text).slice(0, 60),
          err: errBrief(pe),
        })
        console.warn('[filebrowser] 清单解析失败，已跳过:', p)
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
      fbDiag('readFile-fail', { path: p, ...errBrief(e) })
      console.warn('[filebrowser] 清单读取失败，已跳过:', p, e)
    }
  }

  // 分类
  const hostIndexes: { base: string; raw: Record<string, unknown> }[] = []
  const shardByBase = new Map<string, Record<string, unknown>>()
  const legacy: Record<string, unknown>[] = []
  for (const d of docs) {
    const raw = d.raw
    if (Array.isArray(raw.mounts)) {
      hostIndexes.push({ base: d.base, raw })
    } else if ('volumeId' in raw && Array.isArray(raw.children) && !raw.root) {
      // 卷分片 / 旧版单文件卷：都按基名收好，等待被主机索引引用后合并
      shardByBase.set(d.base, raw)
    } else if (raw.root && typeof raw.root === 'object') {
      legacy.push(raw)
    }
    // 其余形态：跳过
  }
  fbDiag('classify', {
    docs: docs.length,
    host: hostIndexes.length,
    shard: shardByBase.size,
    legacy: legacy.length,
    skipped: docs.length - hostIndexes.length - shardByBase.size - legacy.length,
  })

  const out: RawManifest[] = []
  // legacy v1：原样透传
  for (const l of legacy) out.push(l)

  // 主机索引：对每个 mount 取该卷全部分片 → 合并成一棵树 → 挂在该主机根下
  const referencedBases = new Set<string>()
  for (const { base: indexBase, raw: hi } of hostIndexes) {
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
      // 挂载该卷引用的分片基名（不含 .json），供删除整盘/整台主机时定位远端文件。
      drive.shardBases = bases
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
      indexBase,
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
    const text = await readText(fs, p)
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

/** 某块盘的用户标签映射：路径键（卷内 rel / 旧 host-relative）→ 标签数组 */
export type FileTagsMap = Record<string, string[]>

/**
 * 读取某块盘的用户标签。
 *
 * 兼容两代格式（与 zip-browser 的 sharded-tags 逐字对齐）：
 *   - 旧单片 /file-tags/<key>.json            整表 {tags:{...}}，作基线；
 *   - 新事件片 /file-tags/<key>/<年>/*.json   跨年枚举 + 片名升序重放。
 * 404 / 解析失败 / 未连接 → 返回空对象（不抛错，避免阻断浏览）。
 */
export async function getFileTags(key: string): Promise<FileTagsMap> {
  try {
    const fs = getFs()
    // 新片目录用 safeKey（与 zip-browser 对齐）；旧单片基线用历史 sanitizeKey 路径。
    const identity = safeKey(key)
    return await readShardedMap(fs, `${FILE_TAGS_DIR}/${identity}`, `${FILE_TAGS_DIR}/${sanitizeKey(key)}.json`)
  } catch (e) {
    if (isRemoteStorageAuthError(e)) {
      // 权限问题仅告警，不打断浏览
      console.warn('[filebrowser] 读取用户标签权限不足:', e)
    }
    return {}
  }
}

/**
 * 写回某块盘的用户标签：把整表 diff 成事件片追加，不修改已有片。
 * 调用方仍传整表（签名不变），底层只新建 <key>/<年>/tags-<ts>-<rand>.json。
 * 权限错误（401/403）抛 RsAuthError，由调用方提示检查后端；其它错误原样抛出。
 */
export async function putFileTags(key: string, map: FileTagsMap): Promise<void> {
  const fs = getFs()
  const identity = safeKey(key)
  try {
    const oldMap = await getFileTags(key)
    await appendTagDiff(fs, `${FILE_TAGS_DIR}/${identity}`, 'tags', oldMap, map, { key })
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
    throw e
  }
}

/** 删除清单文件时需要调用的接口：数据组 deleteFile（墓碑感知，删除会经同步传播到其它后端） */
interface GroupDeletable {
  deleteFile?(path: string): Promise<void>
}

/**
 * 删除 /struct 下的一个清单文件（主机索引或卷分片）。
 * 优先走数据组权威的 deleteFile（写墓碑，避免同步时被对端复活）；
 * 数据组未暴露 deleteFile 时退回 fs.promises.unlink。
 * 路径按数据组逻辑根计算，不存在的文件视为已删除（幂等）。
 */
async function deleteStructFile(base: string): Promise<void> {
  const group = getDirStructGroup()
  if (!group) throw new RsNotConnectedError()
  const path = `${STRUCT_DIR}/${sanitizeKey(base)}.json`
  const deletable = group as unknown as GroupDeletable
  try {
    if (typeof deletable.deleteFile === 'function') {
      await deletable.deleteFile(path)
    } else {
      await getFs().unlink(path)
    }
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError(FOLDERS_AUTH_MSG)
    throw e
  }
}

/**
 * 删除整台主机：主机索引文件 + 其各盘符引用的全部卷分片。
 * 注意：被多台主机共享的卷分片不会因本次删除被其它主机复活问题——
 * 墓碑保证远端删除；若分片仍被其它主机引用，生成端下次扫描会重新写入。
 * 返回本次实际删除的文件名（基名）列表，供确认/提示。
 */
export async function deleteHostManifest(indexBase: string | undefined, shardBases: string[][]): Promise<string[]> {
  const removed: string[] = []
  if (indexBase) {
    await deleteStructFile(indexBase)
    removed.push(`${indexBase}.json`)
  }
  const allShards = [...new Set(shardBases.flat())]
  for (const base of allShards) {
    await deleteStructFile(base)
    removed.push(`${base}.json`)
  }
  return removed
}

/**
 * 删除单个卷分片（按盘符的 shardBases）。
 * 仅删该盘符引用的分片文件；主机索引保留（下次刷新后该盘可能从索引引用中消失）。
 */
export async function deleteDriveShards(shardBases: string[]): Promise<string[]> {
  const removed: string[] = []
  for (const base of [...new Set(shardBases)]) {
    await deleteStructFile(base)
    removed.push(`${base}.json`)
  }
  return removed
}
