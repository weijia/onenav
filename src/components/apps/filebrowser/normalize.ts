// 归一化层：把原始目录结构清单（RawManifest）收敛为已校验的节点树。
// 清单默认只描述目录结构，但也可能（dir-struct-gen 开启「包含文件」时）含 type:"file" 节点；
// 读取侧保留文件节点用于展示/打标签，但文件不计入 folderCount、不参与目录展开。

import type { FileNodeView, FsNodeView, FolderNodeView, ManifestView, RawManifest } from './types'

interface RawNode {
  name?: unknown
  type?: unknown
  tags?: unknown
  children?: unknown
  /** 文件逻辑大小（字节），仅 type:"file" 节点携带 */
  size?: unknown
  /** 文件占用磁盘空间（字节），仅 type:"file" 节点携带 */
  sizeOnDisk?: unknown
  /** 驱动层节点的稳定身份（来自磁盘根 .dir-struct-id），子目录不携带 */
  volumeId?: unknown
  /** 可选：该目录（含子孙）的总文件数 */
  fileCount?: unknown
  /** 可选：该目录（含子孙）的逻辑大小之和 */
  totalSize?: unknown
  /** 可选：该目录（含子孙）的占用磁盘空间之和 */
  totalSizeOnDisk?: unknown
  /** 可选：数值仅下界 */
  sizePartial?: unknown
  /** 可选：分片来源主机（并集） */
  sources?: unknown
  /** 可选：磁盘上无子目录 */
  leaf?: unknown
  /** 可选：该目录自身在磁盘上的最后修改时间（filesystem mtime），毫秒级 epoch */
  mtime?: unknown
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 把 mtime 字段收敛为毫秒 epoch（接受数字或可解析的日期字符串），非法时返回 null */
function toMtime(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    if (!isNaN(t)) return t
  }
  return null
}

function toTags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
}

/**
 * 将一个原始节点收敛为 FsNodeView；非法节点返回 null 被跳过。
 * - 缺 name：跳过（告警）
 * - type === 'file'：保留为文件节点（无子节点，只展示文件名/大小/mtime）
 * - 其余（无 type 或 'folder'）：视作 folder
 */
function normalizeNode(raw: unknown, warnings: string[]): FsNodeView | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as RawNode

  const name = toStr(node.name)
  if (name == null) {
    warnings.push('发现缺少 name 的节点，已跳过')
    return null
  }

  const type = toStr(node.type) ?? 'folder'
  const tags = toTags(node.tags)
  const mtime = toMtime(node.mtime)

  // 文件节点：保留，但不含子节点、不参与目录统计。
  if (type === 'file') {
    const file: FileNodeView = { name, type: 'file', tags }
    if (typeof node.size === 'number' && node.size >= 0) file.size = node.size
    if (typeof node.sizeOnDisk === 'number' && node.sizeOnDisk >= 0) {
      file.sizeOnDisk = node.sizeOnDisk
    }
    if (mtime != null) file.mtime = mtime
    return file
  }

  const childrenRaw = Array.isArray(node.children) ? node.children : []
  const children: FsNodeView[] = []
  for (const c of childrenRaw) {
    const cn = normalizeNode(c, warnings)
    if (cn) children.push(cn)
  }

  const volumeId = toStr(node.volumeId)
  const out: FolderNodeView = { name, type: 'folder', tags, children }
  // 仅驱动层节点携带稳定身份（子目录不重复存）。
  if (volumeId) out.volumeId = volumeId
  // 可选统计字段：目录下所有文件（含子孙）的数量、逻辑大小、占用空间（由 dir-struct-gen「汇总文件数与大小」生成）。
  // 缺失（未开启统计 / 无访问权限）时该字段不出现，读取侧按需展示。
  if (typeof node.fileCount === 'number' && node.fileCount >= 0) out.fileCount = node.fileCount
  if (typeof node.totalSize === 'number' && node.totalSize >= 0) out.totalSize = node.totalSize
  if (typeof node.totalSizeOnDisk === 'number' && node.totalSizeOnDisk >= 0) {
    out.totalSizeOnDisk = node.totalSizeOnDisk
  }
  // 下界标记：以「≥」展示，避免把读不到的部分当成 0。
  if (node.sizePartial === true) out.sizePartial = true
  // 分片来源主机（多主机合并后的并集），仅分片层可能出现。
  if (Array.isArray(node.sources)) {
    const sources = node.sources.filter((s): s is string => typeof s === 'string')
    if (sources.length) out.sources = sources
  }
  // 磁盘上确实无子目录（合并后由规则重算），读取侧据此省略展开按钮。
  if (node.leaf === true) out.leaf = true
  // 目录自身在磁盘上的最后修改时间（mtime，毫秒级 epoch）。仅展示用途，不参与合并取舍；
  // 缺失（fs.stat 失败 / 权限不足）时不写该字段。
  if (mtime != null) out.mtime = mtime
  return out
}

/** 递归统计文件夹节点数（含自身；文件节点不计入） */
function countFolders(node: FsNodeView): number {
  if (node.type === 'file') return 0
  let n = 1
  for (const c of node.children) n += countFolders(c)
  return n
}

/**
 * 收敛单个原始清单为 ManifestView；缺合法 root 节点时返回 null（该清单被跳过）。
 */
export function normalizeManifest(raw: unknown): ManifestView | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as RawManifest
  const warnings: string[] = []

  const root = normalizeNode(obj.root, warnings)
  if (!root || root.type !== 'folder') {
    // 缺少合法 root 节点（root.type 必须为 folder），跳过该清单。
    return null
  }

  const source = toStr(obj.source) ?? root.name
  const generatedAt = toStr(obj.generatedAt)
  const generator = toStr(obj.generator)

  return {
    source,
    generatedAt,
    generator,
    root,
    folderCount: Math.max(0, countFolders(root) - 1), // 不含根（主机）自身
    warnings,
  }
}

/**
 * 收敛多个原始清单；非法清单被静默跳过。
 * 结果按 source 升序，保证多主机展示顺序稳定。
 */
export function normalizeManifests(raws: unknown[]): ManifestView[] {
  const out: ManifestView[] = []
  for (const r of raws) {
    const m = normalizeManifest(r)
    if (m) out.push(m)
  }
  out.sort((a, b) => a.source.localeCompare(b.source))
  return out
}

/**
 * 按关键词 / 标签 / 目录大小筛选节点树：返回只包含「匹配节点及其祖先链」的树。
 * - 关键词命中：节点名命中 query → 保留该节点；其子节点仅保留同样命中的分支。
 * - 标签命中：节点的清单自带标签（node.tags）或用户标签（userTagsByKey[markKey][path]）含该标签。
 * - 大小命中：目录的 totalSize（缺失时用 totalSizeOnDisk）满足阈值；仅「非根、非盘符」的目录参与。
 * - 三者任一命中即保留（「或」关系）；均未命中但有命中后代时作为祖先路径保留。
 * - 文件节点只能自匹配（关键词/标签），命中时作为叶子保留；不参与大小筛选。
 *
 * opts（全部可选，向后兼容旧的两参调用）：
 *  - tag：筛选标签（null / 空不生效）
 *  - userTagsByKey：用户标签表（与页面 tagsByKey 同结构）
 *  - source：清单来源（用于回退 markKey = source::盘符）
 *  - markKey / basePath：内部递归透传，按盘符命名空间定位用户标签
 *  - sizeFilter：目录大小阈值（字节）与比较方向
 */
export function filterTree(
  node: FsNodeView,
  query: string,
  opts?: {
    tag?: string | null
    userTagsByKey?: Record<string, Record<string, string[]>>
    source?: string
    markKey?: string
    basePath?: string[]
    /** 隐私模式：true 时含 'private' 标签的节点及其子树整体被隐藏 */
    hidePrivate?: boolean
    /** 目录大小筛选（字节）；gt = 大于，lt = 小于。null / 未传 = 不启用 */
    sizeFilter?: { op: 'gt' | 'lt'; bytes: number } | null
  },
): FsNodeView | null {
  const q = query.trim().toLowerCase()
  const tag = opts?.tag ?? null
  const hidePrivate = opts?.hidePrivate ?? false
  const sizeFilter = opts?.sizeFilter ?? null
  const userTagsByKey = opts?.userTagsByKey
  const basePath = opts?.basePath ?? []
  const path = basePath.join('/')

  // 用户标签定位：当前节点若为文件夹，用所在盘的命名空间 key + host-relative 路径查表。
  const userTagsHere: string[] =
    node.type === 'folder' && userTagsByKey && opts?.markKey
      ? userTagsByKey[opts.markKey]?.[path] ?? []
      : []
  // 是否处于筛选模式；非筛选模式下所有节点自匹配（保留整棵子树）。
  const activeFilter = q.length > 0 || tag != null || sizeFilter != null
  const nameMatch = q.length > 0 && node.name.toLowerCase().includes(q)
  const tagHit = tag != null && (node.tags.includes(tag) || userTagsHere.includes(tag))

  // 目录大小是「含全部子孙」的累积值：主机根与盘符几乎必然大于任何阈值，
  // 若让它们参与命中，筛选会退化成整棵树都显示。故只从盘符下的子目录层开始匹配
  // （结构固定为 主机根 basePath=[] → 盘符 length=1 → 子目录 length>=2），
  // 上层节点仅靠「有命中后代」作为祖先路径保留。
  let sizeHit = false
  if (sizeFilter != null && node.type === 'folder' && basePath.length >= 2) {
    const bytes = node.totalSize ?? node.totalSizeOnDisk
    if (bytes !== undefined) {
      sizeHit =
        sizeFilter.op === 'gt'
          ? bytes > sizeFilter.bytes           // 下界已超阈值 → 实际必超，可命中
          : !node.sizePartial && bytes < sizeFilter.bytes // 下界无法证明「实际小于」→ 不参与 lt
    }
  }

  // 隐私标签（'private'）：隐藏模式下该节点及其整棵子树被排除（不展开、不计入筛选）。
  if (hidePrivate) {
    const isPrivate =
      node.tags.some((t) => t.toLowerCase() === 'private') ||
      userTagsHere.some((t) => t.toLowerCase() === 'private')
    if (isPrivate) return null
  }

  const selfMatch = !activeFilter || nameMatch || tagHit || sizeHit

  if (node.type === 'file') {
    return selfMatch ? node : null
  }

  // 顶层子节点（盘符）首次出现时用其自身 identity 计算 markKey，深层节点沿继承。
  const kids = node.children
    .map((c) => {
      const childKey =
        c.type === 'folder' && !opts?.markKey
          ? (c as FolderNodeView).volumeId || `${opts?.source ?? ''}::${c.name}`
          : opts?.markKey
      return filterTree(c, query, {
        tag,
        userTagsByKey,
        source: opts?.source,
        markKey: childKey,
        basePath: [...basePath, c.name],
        hidePrivate,
        sizeFilter,
      })
    })
    .filter((c): c is FsNodeView => c !== null)

  if (selfMatch) {
    return { ...node, children: kids }
  }
  if (kids.length > 0) {
    return { ...node, children: kids }
  }
  return null
}

/**
 * 统计全部清单中含某标签（大小写不敏感）的节点数量，用于隐私目录的「已隐藏 N 个」提示。
 * 沿用 filterTree 的命名空间解析（盘符用 volumeId，回退 主机::盘符）。
 */
export function countTaggedNodes(
  manifests: ManifestView[],
  tag: string,
  userTagsByKey?: Record<string, Record<string, string[]>>,
): number {
  let count = 0
  const lower = tag.toLowerCase()
  const walk = (
    node: FsNodeView,
    markKey: string | undefined,
    source: string | undefined,
    basePath: string[],
  ) => {
    const path = basePath.join('/')
    const userTags: string[] =
      node.type === 'folder' && userTagsByKey && markKey
        ? userTagsByKey[markKey]?.[path] ?? []
        : []
    const hit =
      node.tags.some((t) => t.toLowerCase() === lower) ||
      userTags.some((t) => t.toLowerCase() === lower)
    if (hit) count++
    if (node.type === 'folder') {
      for (const c of node.children) {
        const childKey =
          c.type === 'folder' && !markKey
            ? (c as FolderNodeView).volumeId || `${source ?? ''}::${c.name}`
            : markKey
        walk(c, childKey, source, [...basePath, c.name])
      }
    }
  }
  for (const m of manifests) walk(m.root, undefined, m.source, [])
  return count
}
