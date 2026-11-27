// 按年分片、只追加不覆盖的标签片读写工具。
//
// 与 zip-browser/web/tags-sharded.js 逐字对齐，两个项目连同一个数据组，
// 片格式与重放规则必须完全一致，否则一端写的标签另一端读不到。
//
// 片路径：<类别>/<身份>/<年>/<前缀>-<YYYYMMDD-HHMMSS>-<6位十六进制>.json
// 读取：跨年目录枚举 → 按片名字符串升序 → 重放事件片；旧整表片先作为基线。
// 排序不依赖本机时钟、文件系统 mtime 或片内字段，片名本身就是确定性键。

/** 数据组 fs.promises 的最小形状 */
export interface GroupPromisesFs {
  readFile(path: string, encoding?: string): Promise<any>
  writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<any[]>
  mkdir(path: string, options?: any): Promise<any>
}

const YEAR_RE = /^\d{4}$/
const JSON_RE = /\.json$/i

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

/** 片名时间戳，与 zip-browser tags-sharded.js:stamp 逐字一致。 */
export function stamp(now = Date.now(), random = Math.random()): string {
  const date = new Date(now)
  const time =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const rand = Math.floor(random * 0xffffff).toString(16).padStart(6, '0')
  return `${time}-${rand}`
}

/** 身份安全化，与 zip-browser tags-sharded.js:safeKey 逐字一致。 */
export function safeKey(value: string): string {
  return (
    String(value || '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'unknown'
  )
}

function normalizeNames(entries: unknown[]): string[] {
  return (entries || [])
    .map((e) => (typeof e === 'string' ? e : String((e as any)?.name ?? e)))
    .map((s) => s.replace(/^\.\//, ''))
}

/** 读文本：后端只认 'utf-8'，其余返回字节时兜底解码（同 fetch.ts / ufs.ts） */
async function readText(fs: GroupPromisesFs, path: string): Promise<string> {
  const data = await fs.readFile(path, 'utf-8')
  if (typeof data === 'string') return data
  if (data && typeof data.text === 'function') return await data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return new TextDecoder('utf-8').decode(data as any)
  return String(data ?? '')
}

/** 逐级建目录，忽略 EEXIST（部分后端 mkdir 不认 recursive） */
async function ensureDir(fs: GroupPromisesFs, dir: string): Promise<void> {
  let cur = ''
  for (const part of dir.split('/').filter(Boolean)) {
    cur += `/${part}`
    try {
      await fs.mkdir(cur)
    } catch (e: any) {
      if (e?.code !== 'EEXIST' && !/exist/i.test(String(e?.message ?? e))) throw e
    }
  }
}

export interface Shard {
  name: string
  path: string
  doc: Record<string, any>
}

/**
 * 跨年目录枚举所有片，按片名升序返回。
 * 年份目录只是物理分桶：时钟偏差把片落到相邻年份也无妨，这里枚举全部年份。
 */
export async function listShards(fs: GroupPromisesFs, baseDir: string): Promise<Shard[]> {
  const years = normalizeNames(await fs.readdir(baseDir).catch(() => [] as any[]))
    .filter((name) => YEAR_RE.test(name))
    .sort()
  const out: Shard[] = []
  for (const year of years) {
    const dir = `${baseDir}/${year}`
    const names = normalizeNames(await fs.readdir(dir).catch(() => [] as any[])).filter((name) => JSON_RE.test(name))
    for (const name of names) {
      try {
        const doc = JSON.parse(await readText(fs, `${dir}/${name}`))
        if (doc && typeof doc === 'object') out.push({ name, path: `${dir}/${name}`, doc })
      } catch {
        // 坏片跳过，不阻断整组标签
        continue
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return out
}

/** 追加一片；只新建，不修改已有片。 */
export async function appendShard(
  fs: GroupPromisesFs,
  baseDir: string,
  prefix: string,
  doc: Record<string, unknown>,
  options: { at?: number; random?: number } = {},
): Promise<string> {
  const now = options.at ?? Date.now()
  const dir = `${baseDir}/${new Date(now).getFullYear()}`
  const path = `${dir}/${prefix}-${stamp(now, options.random)}.json`
  await ensureDir(fs, dir)
  await fs.writeFile(path, `${JSON.stringify(doc, null, 2)}\n`)
  return path
}

function asTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
}

/**
 * 重放标签映射：旧整表片 {tags:{rel:[...]}} 作基线，新事件片按序覆盖。
 * op:'set' 覆盖该 rel 的标签数组，op:'remove' 清空。返回 rel → tags。
 */
export function replayTagMap(shards: Shard[]): Record<string, string[]> {
  const tags = new Map<string, string[]>()
  for (const shard of shards) {
    const doc = shard.doc
    if (doc.tags && !Array.isArray(doc.events)) {
      for (const [rel, list] of Object.entries(doc.tags as Record<string, unknown>)) {
        tags.set(rel, asTags(list))
      }
      continue
    }
    for (const event of Array.isArray(doc.events) ? doc.events : []) {
      const rel = String((event as any)?.rel ?? '')
      if ((event as any)?.op === 'remove') tags.delete(rel)
      else if ((event as any)?.op === 'set') tags.set(rel, asTags((event as any).tags))
    }
  }
  const out: Record<string, string[]> = {}
  for (const [rel, arr] of tags) out[rel] = arr
  return out
}

/**
 * 读某身份的标签：旧单片（若存在）作基线，再叠加跨年事件片。
 * 未连接 / 404 / 解析失败一律返回空表，不阻断浏览。
 */
export async function readShardedMap(
  fs: GroupPromisesFs,
  baseDir: string,
  legacyPath: string,
): Promise<Record<string, string[]>> {
  const shards: Shard[] = []
  try {
    const doc = JSON.parse(await readText(fs, legacyPath))
    if (doc && typeof doc === 'object') shards.push({ name: '0000-legacy.json', path: legacyPath, doc })
  } catch {
    // 旧片不存在属正常
  }
  shards.push(...(await listShards(fs, baseDir)))
  shards.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return replayTagMap(shards)
}

/**
 * 把「整表写回」diff 成事件片追加：变化的 rel 发 set，消失的 rel 发 remove。
 * 没有差异时不写任何片（保持调用方整表写回签名不变，但底层只追加）。
 */
export async function appendTagDiff(
  fs: GroupPromisesFs,
  baseDir: string,
  prefix: string,
  oldMap: Record<string, string[]>,
  newMap: Record<string, string[]>,
  extra: Record<string, unknown> = {},
  options: { at?: number; host?: string; random?: number } = {},
): Promise<string | null> {
  const events: Array<Record<string, unknown>> = []
  for (const [rel, tags] of Object.entries(newMap)) {
    const before = oldMap[rel]
    if (!before || JSON.stringify(before) !== JSON.stringify(tags)) {
      events.push({ op: 'set', rel, tags })
    }
  }
  for (const rel of Object.keys(oldMap)) {
    if (!(rel in newMap)) events.push({ op: 'remove', rel })
  }
  if (!events.length) return null
  const now = options.at ?? Date.now()
  return appendShard(
    fs,
    baseDir,
    prefix,
    {
      version: 1,
      at: now,
      host: options.host || 'onenav',
      ...extra,
      events,
    },
    options,
  )
}
