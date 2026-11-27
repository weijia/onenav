// UFS 快照读取侧的纯逻辑（不碰 fs / 浏览器，便于单测）：
// - 解析 zip-browser「+ufs」写出的 bundle 文本（首行 meta + 每行一个扁平节点）；
// - 把扁平节点按 rel 重建为树（父节点缺失时补占位目录）；
// - 自底向上聚合目录的文件数 / 总大小 / 哈希失败数；
// - 按关键词 / 标签过滤（保留命中节点及其祖先链）；
// - 标签文件命名（sanitize + 短哈希，防止不同 id 清洗后撞名）。
//
// bundle 格式来自 zip-browser/web/ufs-store.js（v2）：
//   /ufs/<年份>/ufs-*.jsonl
//   第 1 行 {"v":2,"kind":"ufs-bundle","id","name","type","source","addedAt",...,"summary":{...}}
//   后续每行 {"type":"dir|file","id","rel","name","parentId","mtime","size","hash","hashError","partial"}

export interface UfsSource {
  kind?: string
  path?: string
  volumeId?: string
  rel?: string
  zipPath?: string
  entry?: string
  [key: string]: unknown
}

export interface UfsSummary {
  dirs: number
  files: number
  size: number
  partial: boolean
  hashFailed: number
}

export interface UfsBundleMeta {
  v?: number
  kind?: string
  id: string
  name: string
  type: 'dir' | 'file'
  source?: UfsSource
  addedAt?: number
  mtime?: number | null
  rootNodeId?: string
  summary?: UfsSummary
  createdAt?: number
  /** 读取侧补上的物理路径（/ufs/<年份>/ufs-xxx.jsonl） */
  bundlePath?: string
}

/** bundle 里一行扁平节点（已归一化） */
export interface UfsNode {
  type: 'dir' | 'file'
  id?: string
  rel: string
  name: string
  parentId?: string | null
  mtime?: number
  size?: number | null
  hash?: string
  hashError?: string
  partial?: boolean
}

/** 重建后的树节点；目录额外带聚合统计 */
export interface UfsTreeNode {
  type: 'dir' | 'file'
  name: string
  rel: string
  mtime?: number
  size?: number | null
  hash?: string
  hashError?: string
  partial?: boolean
  /** 目录：子树文件总数 / 总字节 / 哈希失败数 / 子树含不可读部分 */
  fileCount?: number
  totalSize?: number
  hashFailed?: number
  partialTree?: boolean
  /** 由缺失父节点补出来的占位目录 */
  synth?: boolean
  children: UfsTreeNode[]
}

export interface UfsBuildStats {
  dirs: number
  files: number
  size: number
  hashFailed: number
  /** 补出来的占位目录数 */
  synthDirs: number
  /** 重复 rel 被丢弃的节点数 */
  duplicates: number
  /** 无法归类被跳过的节点数 */
  skipped: number
}

/** 路径归一化：反斜杠转正斜杠、去掉首尾斜杠 */
export function normalizeRel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** 节点缺 name 时用 rel 末段兜底 */
export function nodeNameOf(rel: string, rawName: unknown): string {
  const name = String(rawName ?? '').trim()
  if (name) return name
  const parts = rel.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 单行节点 → 归一化节点；形态不对返回 null */
export function normalizeUfsNode(raw: unknown): UfsNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const type = obj.type === 'file' ? 'file' : obj.type === 'dir' ? 'dir' : null
  if (!type) return null
  const rel = normalizeRel(obj.rel)
  const name = nodeNameOf(rel, obj.name)
  if (!name) return null
  const node: UfsNode = { type, rel, name }
  if (typeof obj.id === 'string' && obj.id) node.id = obj.id
  if (obj.parentId === null || typeof obj.parentId === 'string') {
    node.parentId = obj.parentId as string | null
  }
  const mtime = Number(obj.mtime)
  if (Number.isFinite(mtime) && mtime > 0) node.mtime = mtime
  if (type === 'file') {
    const size = Number(obj.size)
    node.size = Number.isFinite(size) ? size : null
    if (typeof obj.hash === 'string' && obj.hash) node.hash = obj.hash
    if (typeof obj.hashError === 'string' && obj.hashError) node.hashError = obj.hashError
  }
  if (obj.partial === true) node.partial = true
  return node
}

/** 首行 meta → 归一化；不是合法 ufs-bundle 返回 null */
export function normalizeUfsBundleMeta(raw: unknown): UfsBundleMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.kind !== 'ufs-bundle') return null
  const id = typeof obj.id === 'string' ? obj.id : ''
  const name = typeof obj.name === 'string' ? obj.name : ''
  if (!id || !name) return null
  const type = obj.type === 'file' ? 'file' : 'dir'
  const meta: UfsBundleMeta = { id, name, type }
  if (Number.isFinite(Number(obj.v))) meta.v = Number(obj.v)
  if (typeof obj.kind === 'string') meta.kind = obj.kind
  if (obj.source && typeof obj.source === 'object' && !Array.isArray(obj.source)) {
    meta.source = obj.source as UfsSource
  }
  const addedAt = Number(obj.addedAt)
  if (Number.isFinite(addedAt) && addedAt > 0) meta.addedAt = addedAt
  if (Number.isFinite(Number(obj.mtime)) && Number(obj.mtime) > 0) meta.mtime = Number(obj.mtime)
  if (typeof obj.rootNodeId === 'string') meta.rootNodeId = obj.rootNodeId
  if (Number.isFinite(Number(obj.createdAt))) meta.createdAt = Number(obj.createdAt)
  if (obj.summary && typeof obj.summary === 'object' && !Array.isArray(obj.summary)) {
    const s = obj.summary as Record<string, unknown>
    meta.summary = {
      dirs: Number.isFinite(Number(s.dirs)) ? Number(s.dirs) : 0,
      files: Number.isFinite(Number(s.files)) ? Number(s.files) : 0,
      size: Number.isFinite(Number(s.size)) ? Number(s.size) : 0,
      partial: s.partial === true,
      hashFailed: Number.isFinite(Number(s.hashFailed)) ? Number(s.hashFailed) : 0,
    }
  }
  return meta
}

/**
 * 解析 bundle 全文：首行必须是 meta，后续每行一个节点。
 * 坏行只计数不抛错（partial 损坏的快照也要能看）。
 */
export function parseBundleText(text: string): {
  meta: UfsBundleMeta | null
  nodes: UfsNode[]
  broken: number
} {
  const lines = String(text ?? '').split(/\r?\n/)
  let meta: UfsBundleMeta | null = null
  let first = true
  let broken = 0
  const nodes: UfsNode[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (first) {
      first = false
      try {
        meta = normalizeUfsBundleMeta(JSON.parse(line))
      } catch {
        meta = null
      }
      if (!meta) broken += 1
      continue
    }
    try {
      const node = normalizeUfsNode(JSON.parse(line))
      if (node) nodes.push(node)
      else broken += 1
    } catch {
      broken += 1
    }
  }
  return { meta, nodes, broken }
}

function cmpNodes(a: UfsTreeNode, b: UfsTreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
}

/**
 * 扁平节点 → 树。
 * - rel 为空的节点视为根（单文件快照时根就是文件）；
 * - 父目录缺失时补一个 synth 占位目录，保证任何节点都能挂上（不丢数据）；
 * - 同 rel 重复只保留第一个，其余计数丢弃；
 * - 目录统计自底向上一次性算好，供行内直接展示。
 */
export function buildUfsTree(
  nodes: UfsNode[],
  meta?: UfsBundleMeta | null,
): { root: UfsTreeNode; stats: UfsBuildStats } {
  const stats: UfsBuildStats = {
    dirs: 0,
    files: 0,
    size: 0,
    hashFailed: 0,
    synthDirs: 0,
    duplicates: 0,
    skipped: 0,
  }

  let rootType: 'dir' | 'file' = meta?.type === 'file' ? 'file' : 'dir'
  let rootName = meta?.name || ''
  let rootMtime: number | undefined
  let rootSize: number | null | undefined = null

  const map = new Map<string, UfsTreeNode>()
  for (const raw of nodes) {
    if (!raw) {
      stats.skipped += 1
      continue
    }
    if (!raw.rel) {
      // 根节点：类型/名称/大小/时间以此为准
      rootType = raw.type
      rootName = rootName || raw.name
      rootMtime = raw.mtime
      rootSize = raw.size
      continue
    }
    if (map.has(raw.rel)) {
      stats.duplicates += 1
      continue
    }
    const node: UfsTreeNode =
      raw.type === 'file'
        ? {
            type: 'file',
            name: raw.name,
            rel: raw.rel,
            mtime: raw.mtime,
            size: raw.size ?? null,
            hash: raw.hash,
            hashError: raw.hashError,
            partial: raw.partial,
            children: [],
          }
        : {
            type: 'dir',
            name: raw.name,
            rel: raw.rel,
            mtime: raw.mtime,
            partial: raw.partial,
            children: [],
          }
    map.set(raw.rel, node)
  }

  const root: UfsTreeNode = {
    type: rootType,
    name: rootName || '（快照根）',
    rel: '',
    mtime: rootMtime,
    ...(rootType === 'file' ? { size: rootSize ?? null } : {}),
    children: [],
  }

  // 逐级补父目录：rel 链上缺失的每一段都建 synth 目录
  const ensureDir = (rel: string): UfsTreeNode => {
    const existing = map.get(rel)
    if (existing) return existing
    const parts = rel.split('/')
    const parentRel = parts.slice(0, -1).join('/')
    if (parentRel) ensureDir(parentRel)
    const dir: UfsTreeNode = {
      type: 'dir',
      name: parts[parts.length - 1],
      rel,
      synth: true,
      children: [],
    }
    map.set(rel, dir)
    stats.synthDirs += 1
    return dir
  }

  for (const rel of [...map.keys()]) {
    const parts = rel.split('/')
    if (parts.length > 1) ensureDir(parts.slice(0, -1).join('/'))
  }

  // 挂到父节点（根挂 root）
  for (const node of map.values()) {
    const parts = node.rel.split('/')
    const parentRel = parts.slice(0, -1).join('/')
    const parent = parentRel ? map.get(parentRel) : root
    if (!parent || parent.type === 'file') {
      // 理论上不会发生（ensureDir 已补齐）；兜底挂根，避免节点丢失
      root.children.push(node)
      continue
    }
    parent.children.push(node)
  }

  // 排序：目录优先、名称自然序（递归）
  const sortRec = (dir: UfsTreeNode) => {
    dir.children.sort(cmpNodes)
    for (const child of dir.children) if (child.type === 'dir') sortRec(child)
  }
  if (root.type === 'dir') sortRec(root)

  // 自底向上聚合（递归深度 = 路径层级，节点总数可能很大，这里只做一次）
  const aggregate = (node: UfsTreeNode): void => {
    if (node.type === 'file') {
      node.fileCount = undefined
      node.totalSize = undefined
      return
    }
    let files = 0
    let size = 0
    let hashFailed = 0
    let partial = node.partial === true
    for (const child of node.children) {
      if (child.type === 'file') {
        files += 1
        size += Number(child.size) || 0
        if (child.hashError) hashFailed += 1
        if (child.partial) partial = true
      } else {
        aggregate(child)
        files += child.fileCount ?? 0
        size += child.totalSize ?? 0
        hashFailed += child.hashFailed ?? 0
        if (child.partialTree) partial = true
      }
    }
    node.fileCount = files
    node.totalSize = size
    node.hashFailed = hashFailed
    node.partialTree = partial
  }
  aggregate(root)

  for (const node of map.values()) {
    if (node.type === 'dir') stats.dirs += 1
    else {
      stats.files += 1
      stats.size += Number(node.size) || 0
      if (node.hashError) stats.hashFailed += 1
    }
  }
  if (rootType === 'dir') stats.dirs += 1
  else {
    stats.files += 1
    stats.size += Number(rootSize) || 0
  }

  return { root, stats }
}

/**
 * 按关键词 / 标签过滤快照树：返回只保留「命中节点及其祖先链」的新树。
 * - 关键词命中节点名（大小写不敏感）；
 * - 标签命中 tags[rel]（快照根 rel 为空串）。
 * 两者都为空时原样返回；无任何命中返回 null。
 */
export function filterUfsTree(
  root: UfsTreeNode,
  query: string,
  tags: Record<string, string[]>,
  tag: string | null,
): UfsTreeNode | null {
  const q = query.trim().toLowerCase()
  if (!q && !tag) return root
  const walk = (node: UfsTreeNode): UfsTreeNode | null => {
    const own = tags[node.rel] || []
    const nameHit = q.length > 0 && node.name.toLowerCase().includes(q)
    const tagHit = tag != null && own.includes(tag)
    const kids =
      node.type === 'dir'
        ? node.children.map(walk).filter((c): c is UfsTreeNode => c !== null)
        : []
    if (nameHit || tagHit) return { ...node, children: kids }
    if (kids.length > 0) return { ...node, children: kids }
    return null
  }
  return walk(root)
}

/** 统计整棵树里带某标签的节点数（用于筛选提示） */
export function countUfsTagged(root: UfsTreeNode, tags: Record<string, string[]>, tag: string): number {
  let n = 0
  const walk = (node: UfsTreeNode) => {
    if ((tags[node.rel] || []).includes(tag)) n += 1
    for (const c of node.children) walk(c)
  }
  walk(root)
  return n
}

/** 32 位 FNV-1a → base36，用于标签文件名后缀（防清洗撞名） */
function shortHash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * 标签文件基名：/ufs-tags/<key>.json。
 * key = 清洗后的 bundle id（限长）+ 原 id 短哈希；同一来源重复加入时 id 稳定，
 * 标签因此能跨次沿用。
 */
export function ufsTagKey(bundleId: string): string {
  const raw = String(bundleId || 'unknown')
  const safe = raw
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return `${safe || 'bundle'}-${shortHash(raw)}`
}

/** 来源 → 展示用的（类别, 明细） */
export function sourceLabel(source?: UfsSource | null): { kind: string; detail: string } {
  if (!source) return { kind: '未知', detail: '' }
  const kind = String(source.kind || '')
  if (kind === 'local') {
    return { kind: '本机', detail: String(source.path || '') }
  }
  if (kind === 'volume') {
    const vol = String(source.volumeId || '')
    const rel = normalizeRel(source.rel)
    return { kind: '卷', detail: rel ? `${vol}/${rel}` : vol }
  }
  if (kind === 'zip') {
    const zip = String(source.zipPath || '')
    const entry = String(source.entry || '')
    return { kind: '压缩包', detail: entry ? `${zip}#${entry}` : zip }
  }
  return { kind: kind || '未知', detail: String(source.path || '') }
}
