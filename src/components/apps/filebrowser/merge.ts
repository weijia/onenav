// 卷分片合并：把同一块物理盘（同一 volumeId）的多份目录结构「分片」合成一棵树。
//
// 严格复刻 dir-struct-gen/app.js 的 mergeVolumeTrees 及配套辅助函数，
// 规则见 my-data/docs/formats/dir-struct-manifest-format.md「分片合并规则」：
//   1) children 取并集（递归合并同名节点）——某台机没扫到不代表目录不存在；
//   2) 同名节点属性按「最后确认时间」取新：节点 updatedAt 优先，回退所属文件 part.generatedAt / generatedAt；
//   3) tags / sources 取并集去重；
//   4) leaf 重算——合并后有子目录就不再是底部节点；
//   5) 同名 folder / file 冲突：folder 优先，不看时间；
//   6) 时间缺失或相差不超过 5 分钟 → 按 part.id 字典序兜底，保证确定性；
//   7) volumeId：两侧谁有取谁，不凭空补 null；
//   8) fileCount / totalSize / totalSizeOnDisk 分别取「各来源整棵子树值」与「合并后可见子项之和」的较大者，
//      任一侧/子项是下界则结果标记 sizePartial。
//
// 结果幂等、确定，仅供读取/展示，不回写成「合并文件」。

type RawNode = Record<string, any>

/** 判定「同一时刻」的容差：多机时钟未必同步 */
const MERGE_TIME_TOLERANCE_MS = 5 * 60 * 1000

/** 时间戳统一成毫秒 epoch：数字直接采信；字符串按 ISO 解析；其它返回 null */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return isNaN(t) ? null : t
  }
  return null
}

function maxStamp(x: number | null, y: number | null): number | null {
  if (x == null) return y == null ? null : y
  if (y == null) return x
  return Math.max(x, y)
}

/** 节点的「最后确认时间」：优先节点自身 updatedAt，其次所属文件的时间 */
function nodeStamp(node: RawNode, fileStamp: number | null): number | null {
  const own = toEpochMs(node && node.updatedAt)
  return own != null ? own : fileStamp
}

/** 冲突归属：时间较新者胜；时间缺失/在容差内 → 按 part.id 字典序取大者 */
function pickNewerSide(
  aStamp: number | null,
  bStamp: number | null,
  aPart: string,
  bPart: string,
): 'a' | 'b' {
  if (aStamp != null && bStamp != null && Math.abs(aStamp - bStamp) > MERGE_TIME_TOLERANCE_MS) {
    return aStamp > bStamp ? 'a' : 'b'
  }
  const pa = aPart || ''
  const pb = bPart || ''
  if (pa === pb) return 'a' // 同一分片自比（幂等）
  return pa > pb ? 'a' : 'b'
}

/** children 的确定性排序：目录优先 + 名称数字感知 */
function sortManifestChildren(children: RawNode[]): RawNode[] {
  children.sort((x, y) => {
    const xf = (x.type || 'folder') === 'folder'
    const yf = (y.type || 'folder') === 'folder'
    if (xf !== yf) return xf ? -1 : 1
    return String(x.name).localeCompare(String(y.name), undefined, { numeric: true })
  })
  for (const c of children) if (Array.isArray(c.children)) sortManifestChildren(c.children)
  return children
}

/** 按替代规则补齐「占用磁盘空间」值：缺失时用逻辑大小顶上（已有真实占用值时不覆盖） */
function fillDiskValuesDeep(node: RawNode): void {
  if (!node || typeof node !== 'object') return
  if ((node.type || 'folder') === 'file') {
    if (typeof node.sizeOnDisk !== 'number' && typeof node.size === 'number') {
      node.sizeOnDisk = node.size
    }
    return
  }
  if (typeof node.totalSizeOnDisk !== 'number' && typeof node.totalSize === 'number') {
    node.totalSizeOnDisk = node.totalSize
  }
  for (const c of Array.isArray(node.children) ? node.children : []) fillDiskValuesDeep(c)
}

/** 子项之和：目录取 fileCount/totalSize/totalSizeOnDisk，文件占位取 size/sizeOnDisk */
function sumChildrenTotals(children: RawNode[]): {
  fileCount: number
  totalSize: number
  totalSizeOnDisk: number
  partial: boolean
} {
  let fileCount = 0
  let totalSize = 0
  let totalSizeOnDisk = 0
  let partial = false
  for (const c of children || []) {
    if ((c.type || 'folder') === 'file') {
      fileCount += 1
      if (typeof c.size === 'number') totalSize += c.size
      else partial = true
      if (typeof c.sizeOnDisk === 'number') totalSizeOnDisk += c.sizeOnDisk
      else if (typeof c.size === 'number') totalSizeOnDisk += c.size
      else partial = true
    } else {
      if (typeof c.fileCount === 'number') fileCount += c.fileCount
      else partial = true
      if (typeof c.totalSize === 'number') totalSize += c.totalSize
      else partial = true
      if (typeof c.totalSizeOnDisk === 'number') totalSizeOnDisk += c.totalSizeOnDisk
      else if (typeof c.totalSize === 'number') totalSizeOnDisk += c.totalSize
      else partial = true
    }
    if (c.sizePartial) partial = true
  }
  return { fileCount, totalSize, totalSizeOnDisk, partial }
}

interface MergeCtx {
  aPart?: string
  bPart?: string
  aStamp?: number | null
  bStamp?: number | null
  _diskFilled?: boolean
}

/** 合并两棵子树 / 两份卷分片（复刻 mergeVolumeTrees） */
function mergeVolumeTrees(a: RawNode, b: RawNode, ctx?: MergeCtx): RawNode {
  if (!ctx || !ctx._diskFilled) {
    fillDiskValuesDeep(a)
    fillDiskValuesDeep(b)
    ctx = { ...(ctx || {}), _diskFilled: true }
  }
  const aPart = ctx.aPart || ''
  const bPart = ctx.bPart || ''
  const aStamp = nodeStamp(a, ctx.aStamp ?? null)
  const bStamp = nodeStamp(b, ctx.bStamp ?? null)

  // 1) 同名类型冲突：folder 优先，不看时间
  const aFolder = (a.type || 'folder') === 'folder'
  const bFolder = (b.type || 'folder') === 'folder'
  const keepA =
    aFolder !== bFolder ? aFolder : pickNewerSide(aStamp, bStamp, aPart, bPart) === 'a'

  // 2) children 永远取并集：同名节点递归合并，其余直接并入
  const map = new Map<string, { node: RawNode; part: string; stamp: number | null }>()
  const put = (child: RawNode, sidePart: string, sideStamp: number | null) => {
    const key = String(child.name)
    if (!map.has(key)) {
      map.set(key, { node: child, part: sidePart, stamp: sideStamp })
      return
    }
    const prev = map.get(key)!
    map.set(key, {
      node: mergeVolumeTrees(prev.node, child, {
        aPart: prev.part,
        bPart: sidePart,
        aStamp: prev.stamp,
        bStamp: sideStamp,
        _diskFilled: true,
      }),
      part: (prev.part || '') > (sidePart || '') ? prev.part : sidePart,
      stamp: maxStamp(prev.stamp, sideStamp),
    })
  }
  for (const c of Array.isArray(a.children) ? a.children : []) put(c, aPart, aStamp)
  for (const c of Array.isArray(b.children) ? b.children : []) put(c, bPart, bStamp)
  const children = sortManifestChildren([...map.values()].map((x) => x.node))

  // 3) 属性取胜者；tags / sources 取并集去重
  const out: RawNode = { ...(keepA ? a : b), children }
  const tags = [...new Set([...(a.tags || []), ...(b.tags || [])])]
  if (tags.length) out.tags = tags
  else delete out.tags
  const sources = [...new Set([...(a.sources || []), ...(b.sources || [])])]
  if (sources.length) out.sources = sources
  else delete out.sources
  // volumeId：谁有取谁，不凭空补 null（否则破坏幂等）
  const vid = a.volumeId || b.volumeId
  if (vid) out.volumeId = vid

  // 4) leaf 重算：合并后有子目录 → 不再是底部节点
  if ((out.type || 'folder') === 'folder') {
    const hasFolderChild = children.some((c) => (c.type || 'folder') === 'folder')
    if (hasFolderChild) delete out.leaf
    else if (a.leaf === true || b.leaf === true) out.leaf = true
    else delete out.leaf
  }

  // 5) updatedAt 取较新；合并结果不再是单个物理分片 → 去掉 part
  const stamp = maxStamp(aStamp, bStamp)
  if (stamp != null) out.updatedAt = stamp
  else delete out.updatedAt
  if (out.part && aPart !== bPart) delete out.part

  // 9) mtime 仅展示属性、不参与合并取舍：保留任一侧已有的 mtime（优先胜出侧，无值时另一侧兜底）。
  //    合并逻辑不得用 mtime 覆盖 updatedAt 或反过来。
  const mt = keepA ? (a.mtime ?? b.mtime) : (b.mtime ?? a.mtime)
  const mtMs = toEpochMs(mt)
  if (mtMs != null) out.mtime = mtMs
  else delete out.mtime

  // 6) 两套大小字段与合并结果保持一致（逐个取 max）
  if ((out.type || 'folder') === 'folder') {
    const sum = sumChildrenTotals(children)
    const aCount = typeof a.fileCount === 'number' ? a.fileCount : 0
    const bCount = typeof b.fileCount === 'number' ? b.fileCount : 0
    const aSize = typeof a.totalSize === 'number' ? a.totalSize : 0
    const bSize = typeof b.totalSize === 'number' ? b.totalSize : 0
    const aDisk =
      typeof a.totalSizeOnDisk === 'number'
        ? a.totalSizeOnDisk
        : typeof a.totalSize === 'number'
          ? a.totalSize
          : 0
    const bDisk =
      typeof b.totalSizeOnDisk === 'number'
        ? b.totalSizeOnDisk
        : typeof b.totalSize === 'number'
          ? b.totalSize
          : 0
    const hasAny =
      aCount || bCount || aSize || bSize || aDisk || bDisk ||
      sum.fileCount || sum.totalSize || sum.totalSizeOnDisk
    if (hasAny) {
      out.fileCount = Math.max(aCount, bCount, sum.fileCount)
      out.totalSize = Math.max(aSize, bSize, sum.totalSize)
      out.totalSizeOnDisk = Math.max(aDisk, bDisk, sum.totalSizeOnDisk)
      if (a.sizePartial || b.sizePartial || sum.partial) out.sizePartial = true
      else delete out.sizePartial
    }
  }

  return out
}

/** 分片所属 part.id：优先 part.id，回退 sources[0]（旧文件可能没有 part） */
function partIdOfDoc(doc: RawNode): string {
  if (!doc) return ''
  if (doc.part && doc.part.id) return String(doc.part.id)
  if (Array.isArray(doc.sources) && doc.sources.length) return String(doc.sources[0])
  return ''
}

/** 分片整体时间戳：优先 part.generatedAt，其次顶层 generatedAt（兼容旧 ISO 字符串） */
function docStamp(doc: RawNode): number | null {
  if (!doc) return null
  if (doc.part) {
    const t = toEpochMs(doc.part.generatedAt)
    if (t != null) return t
  }
  return toEpochMs(doc.generatedAt)
}

/** 深拷贝：合并过程会就地补字段（fillDiskValuesDeep），避免污染原始解析结果 */
function cloneDoc<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v)
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * 把同一块盘的若干分片合并成一棵树。
 * - docs 顺序不影响结果（合并规则确定性），但调用方宜按基名排序后再传，便于复现。
 * - 单分片时也会按替代规则补齐 totalSizeOnDisk（与生成器「取不到占用就用逻辑大小」一致）。
 * - 无有效输入返回 null。
 */
export function mergeShards(docs: RawNode[]): RawNode | null {
  const valid = docs.filter((d) => d && typeof d === 'object')
  if (!valid.length) return null

  let acc: { doc: RawNode; part: string; stamp: number | null } | null = null
  for (const raw of valid) {
    const doc = cloneDoc(raw)
    // 统一先补齐占用值，保证单分片与多分片口径一致、结果幂等
    fillDiskValuesDeep(doc)
    const part = partIdOfDoc(doc)
    const stamp = docStamp(doc)
    if (!acc) {
      acc = { doc, part, stamp }
      continue
    }
    const merged = mergeVolumeTrees(acc.doc, doc, {
      aPart: acc.part,
      bPart: part,
      aStamp: acc.stamp,
      bStamp: stamp,
      _diskFilled: true,
    })
    acc = {
      doc: merged,
      part: (acc.part || '') > (part || '') ? acc.part : part,
      stamp: maxStamp(acc.stamp, stamp),
    }
  }
  return acc ? acc.doc : null
}
