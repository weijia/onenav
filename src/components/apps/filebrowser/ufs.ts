// UFS 快照的读取层（浏览器侧）：从与 dir-struct-gen / zip-browser 共用的数据组里
// 读 /ufs 下的快照 bundle，读写 /ufs-tags 下的标签。
//
// 写入方是 zip-browser 的「+ufs」：
//   /ufs/<年份>/ufs-*.jsonl  —— 自包含快照（首行 meta，后续每行一个节点）
//   /ufs/<年份>/ufs-*.json   —— 旧格式分片（只读兼容，只有条目、没有节点树）
// 本文件只读快照、只写标签；不复制、不改写任何 bundle。
//
// 标签文件：/ufs-tags/<ufsTagKey(bundle.id)>.json
//   { "version":1, "bundleId":"...", "updatedAt":123, "tags": { "<rel>": ["标签"] } }
// 根节点 rel 为空串。

import { getDirStructGroup, isDirStructGroupReady } from '@/lib/dir-struct-group'
import { isRemoteStorageAuthError } from '@/lib/remotestorage-connection'
import { RsAuthError, RsNotConnectedError } from './fetch'
import {
  normalizeUfsBundleMeta,
  parseBundleText,
  ufsTagKey,
  type UfsBundleMeta,
  type UfsNode,
  type UfsSource,
} from './ufsTree'

/** 统一从读取层再导出，调用方（UfsView）不必同时依赖 fetch.ts */
export { RsAuthError, RsNotConnectedError }

export { ufsTagKey }

export const UFS_ROOT = '/ufs'
export const UFS_TAGS_DIR = '/ufs-tags'

/** 单年目录的物理统计（不读文件内容，只 readdir） */
export interface UfsYearRow {
  year: number
  bundles: number
  legacy: number
}

/** 快照卡片：meta + 物理路径 */
export interface UfsBundleCard extends UfsBundleMeta {
  bundlePath: string
}

/** 旧格式分片里的一条条目（只能列出，没有节点树） */
export interface UfsLegacyEntry {
  name: string
  type: 'dir' | 'file'
  source?: UfsSource
  addedAt?: number
  size?: number | null
  path: string
  year: number
}

export interface UfsYearData {
  year: number
  bundles: UfsBundleCard[]
  legacy: UfsLegacyEntry[]
  broken: number
  files: string[]
}

/** 数据组 fs.promises 的最小形状（与 fetch.ts 保持一致） */
interface GroupPromisesFs {
  readFile(path: string, encoding?: string): Promise<any>
  writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<any[]>
  open?(path: string, flags?: string): Promise<any>
}

function getFs(): GroupPromisesFs {
  const group = getDirStructGroup()
  const p = (group as any)?.fs?.promises as GroupPromisesFs | undefined
  if (!p) throw new RsNotConnectedError()
  return p
}

function isMissing(err: unknown): boolean {
  const e = err as any
  return e?.code === 'ENOENT' || /ENOENT|no such file|not exist|不存在/i.test(String(e?.message || e))
}

/** 读文本：后端只认 'utf-8'，其余返回字节时兜底解码（同 fetch.ts） */
async function readText(fs: GroupPromisesFs, path: string): Promise<string> {
  const data = await fs.readFile(path, 'utf-8')
  if (typeof data === 'string') return data
  if (data && typeof data.text === 'function') return await data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return new TextDecoder('utf-8').decode(data as any)
  return String(data ?? '')
}

/** readdir → 纯名称数组（去掉 ./ 前缀），兼容字符串与 { name } 两种条目 */
async function listNames(fs: GroupPromisesFs, dir: string): Promise<string[]> {
  let entries: any[] = []
  for (const d of [dir, `${dir}/`]) {
    try {
      const list = await fs.readdir(d)
      if (list.length > 0) {
        entries = list
        break
      }
    } catch (e) {
      if (isMissing(e)) continue
      // 其它错误（权限等）交给上层分类，这里只记一次
      throw e
    }
  }
  return entries
    .map((e) => (typeof e === 'string' ? e : String((e as any)?.name ?? e)))
    .map((name) => name.replace(/^\.\//, ''))
}

/** 同步组冷启动等待：直接切到 UFS 视图时也要先等组挂上 */
export async function waitUfsReady(timeoutMs = 35_000): Promise<boolean> {
  const t0 = Date.now()
  if (isDirStructGroupReady()) return true
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500))
    if (isDirStructGroupReady()) return true
  }
  return false
}

/** 触发一次双向同步，把远端新增的 bundle 拉到本地缓存 */
export async function flushUfsGroup(): Promise<void> {
  const group = getDirStructGroup()
  try {
    if (group && typeof (group as any).flush === 'function') await (group as any).flush()
  } catch (e) {
    console.warn('[ufs] 同步组刷新失败:', e)
  }
}

/** 列出 /ufs 下全部年份目录（只 readdir，不读文件） */
export async function listUfsYears(): Promise<UfsYearRow[]> {
  let fs: GroupPromisesFs
  try {
    fs = getFs()
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError('读取 UFS 权限不足')
    throw e
  }
  let names: string[]
  try {
    names = await listNames(fs, UFS_ROOT)
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError('读取 UFS 权限不足')
    if (isMissing(e)) return []
    throw e
  }
  const years = names.filter((n) => /^\d{4}$/.test(n)).map(Number)
  years.sort((a, b) => b - a)
  const rows: UfsYearRow[] = []
  for (const year of years) {
    try {
      const entries = await listNames(fs, `${UFS_ROOT}/${year}`)
      const bundles = entries.filter((n) => /^ufs-.*\.jsonl$/i.test(n)).length
      const legacy = entries.filter((n) => /^ufs-.*\.json$/i.test(n)).length
      if (!bundles && !legacy) continue
      rows.push({ year, bundles, legacy })
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError('读取 UFS 权限不足')
      // 单个年份目录读失败不影响其它年份
      console.warn('[ufs] 年份目录读取失败:', year, e)
    }
  }
  return rows
}

/** 只读文件头（首行 meta）；后端不支持 open 时退回整读再截断 */
async function readTextHead(fs: GroupPromisesFs, path: string, limit = 16_384): Promise<string> {
  if (typeof fs.open === 'function') {
    let handle: any = null
    try {
      handle = await fs.open(path, 'r')
      if (handle && typeof handle.read === 'function') {
        const buffer = new Uint8Array(limit)
        const res = await handle.read(buffer, 0, limit, 0)
        const read = typeof res === 'number' ? res : Number(res?.bytesRead)
        if (Number.isFinite(read) && read > 0) {
          const bytes =
            res?.buffer instanceof Uint8Array ? res.buffer.subarray(0, read) : buffer.subarray(0, read)
          return new TextDecoder('utf-8').decode(bytes)
        }
      }
    } catch {
      // 后端不实现 open/read：走整读兜底
    } finally {
      if (handle && typeof handle.close === 'function') await handle.close().catch(() => {})
    }
  }
  return (await readText(fs, path)).slice(0, limit)
}

/** 读一个 bundle 的首行 meta（不带节点），失败返回 null */
export async function readUfsBundleMeta(bundlePath: string): Promise<UfsBundleMeta | null> {
  const fs = getFs()
  const head = await readTextHead(fs, bundlePath)
  const first = String(head || '').split(/\r?\n/, 1)[0]
  if (!first || !first.trim()) return null
  try {
    const meta = normalizeUfsBundleMeta(JSON.parse(first))
    if (!meta) return null
    return { ...meta, bundlePath }
  } catch {
    return null
  }
}

/** 读某年份目录：全部快照 meta（按加入时间倒序）+ 旧格式条目 */
export async function listUfsBundles(year: number): Promise<UfsYearData> {
  const fs = getFs()
  const dir = `${UFS_ROOT}/${year}`
  const names = await listNames(fs, dir)
  const bundleFiles = names.filter((n) => /^ufs-.*\.jsonl$/i.test(n)).sort()
  const legacyFiles = names.filter((n) => /^ufs-.*\.json$/i.test(n)).sort()

  const bundles: UfsBundleCard[] = []
  let broken = 0
  for (const name of bundleFiles) {
    const path = `${dir}/${name}`
    try {
      const meta = await readUfsBundleMeta(path)
      if (meta) bundles.push({ ...meta, bundlePath: path })
      else broken += 1
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError('读取 UFS 权限不足')
      broken += 1
    }
  }
  bundles.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0))

  const legacy: UfsLegacyEntry[] = []
  for (const name of legacyFiles) {
    const path = `${dir}/${name}`
    try {
      const doc = JSON.parse(await readText(fs, path))
      const entries = Array.isArray(doc?.entries) ? doc.entries : []
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue
        const obj = raw as Record<string, unknown>
        const entryName = String(obj.name || '').trim()
        if (!entryName) continue
        const type = obj.type === 'file' ? 'file' : 'dir'
        const entry: UfsLegacyEntry = { name: entryName, type, path, year }
        if (obj.source && typeof obj.source === 'object') entry.source = obj.source as UfsSource
        const addedAt = Number(obj.addedAt)
        if (Number.isFinite(addedAt) && addedAt > 0) entry.addedAt = addedAt
        const size = Number(obj.size)
        if (Number.isFinite(size)) entry.size = size
        legacy.push(entry)
      }
    } catch (e) {
      if (isRemoteStorageAuthError(e)) throw new RsAuthError('读取 UFS 权限不足')
      console.warn('[ufs] 旧分片解析失败:', path, e)
    }
  }
  legacy.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0))

  return { year, bundles, legacy, broken, files: bundleFiles }
}

/** 读完整快照（meta + 节点），供展开树用 */
export async function readUfsBundle(bundlePath: string): Promise<{
  meta: UfsBundleMeta | null
  nodes: UfsNode[]
  broken: number
}> {
  const fs = getFs()
  let text: string
  try {
    text = await readText(fs, bundlePath)
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError('读取 UFS 权限不足')
    throw e
  }
  return parseBundleText(text)
}

/** 某快照的用户标签：rel → tags（根为 ''） */
export async function readUfsTags(bundleId: string): Promise<Record<string, string[]>> {
  try {
    const fs = getFs()
    const path = `${UFS_TAGS_DIR}/${ufsTagKey(bundleId)}.json`
    const obj = JSON.parse(await readText(fs, path))
    const rawTags = obj && typeof obj === 'object' ? obj.tags : null
    if (!rawTags || typeof rawTags !== 'object' || Array.isArray(rawTags)) return {}
    const out: Record<string, string[]> = {}
    for (const [rel, value] of Object.entries(rawTags as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const tags = value.filter((t): t is string => typeof t === 'string' && !!t)
      if (tags.length) out[rel] = tags
    }
    return out
  } catch (e) {
    if (isRemoteStorageAuthError(e)) {
      console.warn('[ufs] 读取标签权限不足:', e)
    }
    return {}
  }
}

/** 写回某快照的用户标签（空表时直接删除该文件，避免残留空对象） */
export async function putUfsTags(bundleId: string, tags: Record<string, string[]>): Promise<void> {
  const fs = getFs()
  const path = `${UFS_TAGS_DIR}/${ufsTagKey(bundleId)}.json`
  try {
    if (!Object.keys(tags).length) {
      try {
        await fs.unlink(path)
      } catch (e) {
        if (!isMissing(e)) throw e
      }
      return
    }
    await fs.writeFile(
      path,
      JSON.stringify({ version: 1, bundleId, updatedAt: Date.now(), tags }),
    )
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError('写入 UFS 标签权限不足')
    throw e
  }
}

/** 删除一份快照文件（走数据组 deleteFile 写墓碑，避免同步复活） */
export async function deleteUfsBundle(bundlePath: string): Promise<void> {
  if (!String(bundlePath || '').startsWith(`${UFS_ROOT}/`)) throw new Error('只允许删除 /ufs 下的快照')
  const group = getDirStructGroup()
  if (!group) throw new RsNotConnectedError()
  const deletable = group as unknown as { deleteFile?: (path: string) => Promise<void> }
  try {
    if (typeof deletable.deleteFile === 'function') await deletable.deleteFile(bundlePath)
    else await getFs().unlink(bundlePath)
  } catch (e) {
    if (isRemoteStorageAuthError(e)) throw new RsAuthError('删除 UFS 快照权限不足')
    if (isMissing(e)) return
    throw e
  }
}
