// UFS 视图：专门浏览数据组 /ufs 下的快照（zip-browser「+ufs」写出的 ufs-*.jsonl）。
//
// 三层结构：年份目录 → 快照卡片 → 只读目录树。
// - 列表只读每个 bundle 的首行 meta（代价最低），点「展开树」才读全文并重建树；
// - 树是只读快照，onenav 里不能打开本机文件；
// - 每行（目录/文件）都能打标签，标签存 /ufs-tags/<key>.json，与 struct 的 /file-tags 互不干扰；
// - 标签按 bundle id 命名空间：同一来源重复「+ufs」得到同一 id，标签自动沿用；
// - 标签表与树解耦：给快照根打标签不需要先读整份 bundle；
// - 「移出」只删这一份快照索引文件（走数据组 deleteFile 墓碑），不动原目录。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  File as FileIcon,
  Folder,
  FolderOpen,
  Hash,
  Plug,
  RefreshCw,
  Search,
  Tag,
  Trash2,
} from 'lucide-react'
import { formatCount, formatMtime, formatSize } from './format'
import { UserTagChip, TagEditorModal } from './tag-ui'
import { buildUfsTree, filterUfsTree, sourceLabel, type UfsBuildStats, type UfsTreeNode } from './ufsTree'
import {
  UFS_ROOT,
  deleteUfsBundle,
  flushUfsGroup,
  listUfsBundles,
  listUfsYears,
  putUfsTags,
  readUfsBundle,
  readUfsTags,
  waitUfsReady,
  RsAuthError,
  RsNotConnectedError,
  type UfsBundleCard,
  type UfsLegacyEntry,
  type UfsYearData,
  type UfsYearRow,
} from './ufs'
import { readUfsYearsCache, writeUfsYearsCache } from './cache'

const TAG_MAP_EMPTY: Record<string, string[]> = {}

interface TreeState {
  root?: UfsTreeNode
  stats?: UfsBuildStats
  broken?: number
  loading?: boolean
  error?: string
}

interface TagEditorState {
  /** TagEditorModal 要求的 key（这里等于 bundleId） */
  key: string
  bundleId: string
  bundlePath: string
  /** 节点 rel；快照根为空串 */
  path: string
  current: string[]
}

/** 每层先渲染的条目数，剩下点「显示更多」追加（避免超大目录一次铺满 DOM） */
const PAGE = 200

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function UfsView({
  collapseSignal,
  reloadSignal,
}: {
  collapseSignal: number
  reloadSignal: number
}) {
  const [years, setYears] = useState<UfsYearRow[] | null>(null)
  const [cacheAt, setCacheAt] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')

  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  const [openYears, setOpenYears] = useState<Record<number, boolean>>({})
  const [yearData, setYearData] = useState<Record<number, UfsYearData>>({})
  const [yearLoading, setYearLoading] = useState<Record<number, boolean>>({})

  const [trees, setTrees] = useState<Record<string, TreeState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // 标签表按 bundlePath 存放，和树分开：未展开的快照也能看/改根标签
  const [bundleTags, setBundleTagsState] = useState<Record<string, Record<string, string[]>>>({})
  const tagsRef = useRef<Record<string, Record<string, string[]>>>({})

  const [tagEditor, setTagEditor] = useState<TagEditorState | null>(null)
  const [writeError, setWriteError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<{ path: string; name: string } | null>(null)
  const [removing, setRemoving] = useState(false)

  const setBundleTags = useCallback((bundlePath: string, map: Record<string, string[]>) => {
    tagsRef.current = { ...tagsRef.current, [bundlePath]: map }
    setBundleTagsState(tagsRef.current)
  }, [])

  // 读某年目录：快照 meta + 旧格式条目
  const loadYear = useCallback(async (year: number) => {
    setYearLoading((s) => ({ ...s, [year]: true }))
    try {
      const data = await listUfsBundles(year)
      // 顺带读这一年的标签小文件：这样没展开树的快照也能显示根标签、参与标签筛选
      const loaded = await Promise.all(
        data.bundles.map(async (c) => {
          try {
            return [c.bundlePath, await readUfsTags(c.id)] as const
          } catch {
            return [c.bundlePath, TAG_MAP_EMPTY] as const
          }
        }),
      )
      const tagMap = { ...tagsRef.current }
      for (const [path, map] of loaded) tagMap[path] = map
      tagsRef.current = tagMap
      setBundleTagsState(tagMap)
      setYearData((s) => ({ ...s, [year]: data }))
    } catch (e) {
      setError(errorText(e))
      setErrorCode(
        e instanceof RsAuthError ? 'AUTH' : e instanceof RsNotConnectedError ? 'NOT_CONNECTED' : 'UNKNOWN',
      )
    } finally {
      setYearLoading((s) => ({ ...s, [year]: false }))
    }
  }, [])

  // 读年份列表：先画缓存，再等组就绪、同步、拉新
  const loadYears = useCallback(async () => {
    setError('')
    setErrorCode('')
    try {
      const cached = await readUfsYearsCache()
      if (cached) {
        setYears(cached.years as UfsYearRow[])
        setCacheAt(cached.at)
      }
    } catch {
      /* 缓存不可用就当没有 */
    }
    try {
      const ready = await waitUfsReady()
      if (!ready) throw new RsNotConnectedError()
      await flushUfsGroup()
      const rows = await listUfsYears()
      setYears(rows)
      setCacheAt(null)
      void writeUfsYearsCache(rows)
    } catch (e) {
      if (e instanceof RsAuthError) setErrorCode('AUTH')
      else if (e instanceof RsNotConnectedError) setErrorCode('NOT_CONNECTED')
      else setErrorCode('UNKNOWN')
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void loadYears()
  }, [loadYears, reloadSignal])

  // 首次拿到年份：自动展开最新一年并读它的快照。
  // 缓存先到时同步组可能还没好：等就绪再读，避免把「还在连」报成错误。
  useEffect(() => {
    if (!years || years.length === 0) return
    if (Object.values(openYears).some(Boolean)) return
    const newest = years[0].year
    setOpenYears({ [newest]: true })
    let alive = true
    void (async () => {
      const ready = await waitUfsReady()
      if (alive && ready) void loadYear(newest)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years])

  const toggleYear = (year: number) => {
    const next = !openYears[year]
    setOpenYears((s) => ({ ...s, [year]: next }))
    if (next && !yearData[year]) void loadYear(year)
  }

  // 展开某快照：读全文 → 重建树 → 读标签
  const loadTree = useCallback(
    async (card: UfsBundleCard) => {
      const key = card.bundlePath
      setTrees((s) => ({ ...s, [key]: { ...(s[key] || {}), loading: true, error: '' } }))
      try {
        const [bundle, tagMap] = await Promise.all([readUfsBundle(key), readUfsTags(card.id)])
        if (!bundle.meta && bundle.nodes.length === 0) throw new Error('快照首行损坏，读不出内容')
        const { root, stats } = buildUfsTree(bundle.nodes, bundle.meta || card)
        setTrees((s) => ({ ...s, [key]: { root, stats, broken: bundle.broken, loading: false } }))
        setBundleTags(key, tagMap)
      } catch (e) {
        setTrees((s) => ({ ...s, [key]: { ...(s[key] || {}), loading: false, error: errorText(e) } }))
      }
    },
    [setBundleTags],
  )

  const toggleBundle = (card: UfsBundleCard) => {
    const key = card.bundlePath
    const next = !expanded[key]
    setExpanded((s) => ({ ...s, [key]: next }))
    if (next && !trees[key]?.root && !trees[key]?.loading) void loadTree(card)
  }

  // 保存某节点标签：先改 UI，再写回 /ufs-tags
  const applyTags = useCallback(
    (bundleId: string, bundlePath: string, rel: string, tags: string[]) => {
      const prev = tagsRef.current[bundlePath] || {}
      const map = { ...prev }
      const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
      if (cleaned.length) map[rel] = cleaned
      else delete map[rel]
      setBundleTags(bundlePath, map)
      putUfsTags(bundleId, map)
        .then(() => setWriteError(''))
        .catch((err) => setWriteError(`标签保存失败：${errorText(err)}`))
    },
    [setBundleTags],
  )

  // 打开标签弹窗：标签没读过就先读一次（只读一个小文件，不读整份快照）
  const openTagEditor = useCallback(
    async (card: UfsBundleCard, rel: string) => {
      const key = card.bundlePath
      if (!tagsRef.current[key]) {
        try {
          const tagMap = await readUfsTags(card.id)
          setBundleTags(key, tagMap)
          setTagEditor({ key: card.id, bundleId: card.id, bundlePath: key, path: rel, current: tagMap[rel] || [] })
        } catch (e) {
          setWriteError(`读取标签失败：${errorText(e)}`)
        }
        return
      }
      setTagEditor({
        key: card.id,
        bundleId: card.id,
        bundlePath: key,
        path: rel,
        current: tagsRef.current[key]?.[rel] || [],
      })
    },
    [setBundleTags],
  )

  // 移出 UFS：删这一份快照文件，刷新该年与年份统计
  const doRemove = async () => {
    if (!confirmRemove) return
    const { path } = confirmRemove
    // /ufs/<year>/<file> → 取年份目录名
    const year = Number(path.split('/')[2])
    setRemoving(true)
    try {
      await deleteUfsBundle(path)
      setTrees((s) => {
        const m = { ...s }
        delete m[path]
        return m
      })
      setExpanded((s) => {
        const m = { ...s }
        delete m[path]
        return m
      })
      setYearData((s) => {
        const m = { ...s }
        delete m[year]
        return m
      })
      setConfirmRemove(null)
      if (Number.isFinite(year)) {
        setOpenYears((s) => ({ ...s, [year]: true }))
        await loadYear(year)
      }
      await loadYears()
    } catch (e) {
      setWriteError(`移出失败：${errorText(e)}`)
      setConfirmRemove(null)
    } finally {
      setRemoving(false)
    }
  }

  // 全部已用过的标签 + 计数（来自已读取的快照标签表）
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const map of Object.values(bundleTags)) {
      for (const arr of Object.values(map)) {
        for (const t of arr) counts.set(t, (counts.get(t) || 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
  }, [bundleTags])

  const allTags = useMemo(() => tagCounts.map(([t]) => t), [tagCounts])

  const totalSnapshots = useMemo(() => (years ?? []).reduce((n, y) => n + y.bundles, 0), [years])

  const q = query.trim().toLowerCase()

  return (
    <div className="space-y-3">
      {/* 统计 + 搜索 */}
      {years !== null && (
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-white/45">
            {totalSnapshots} 个快照 · {years.length} 个年份
          </span>
          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 text-white/35 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选快照名 / 已展开的树…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/85 text-sm placeholder:text-white/30 outline-none focus:border-white/25"
            />
          </div>
          {(q || tagFilter) && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setTagFilter(null)
              }}
              className="text-white/40 hover:text-white"
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      {tagCounts.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-white/40">UFS 标签</span>
          {tagCounts.slice(0, 24).map(([t, n]) => (
            <UserTagChip
              key={t}
              tag={`${t} ${n}`}
              active={tagFilter === t}
              onClick={() => setTagFilter((prev) => (prev === t ? null : t))}
            />
          ))}
          {tagCounts.length > 24 && <span className="text-white/30">…共 {tagCounts.length} 个</span>}
        </div>
      )}

      {writeError && (
        <div className="rounded-lg border px-3 py-2 text-xs bg-rose-500/10 border-rose-400/30 text-rose-100/85 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="break-all">{writeError}</span>
          <button type="button" onClick={() => setWriteError('')} className="ml-auto text-white/50 hover:text-white">
            关闭
          </button>
        </div>
      )}

      {cacheAt !== null && (
        <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed bg-amber-500/10 border-amber-400/25 text-amber-100/85 flex items-center gap-2 flex-wrap">
          <span>当前显示本机缓存（{formatMtime(cacheAt) ?? '—'}），正在读取 /ufs …</span>
          <button
            type="button"
            onClick={() => void loadYears()}
            className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-amber-50/90"
          >
            立即重试
          </button>
        </div>
      )}

      {error && (
        <div
          className={`rounded-xl border p-4 text-xs leading-relaxed ${
            errorCode === 'AUTH'
              ? 'bg-amber-500/10 border-amber-400/30 text-amber-100/85'
              : 'bg-rose-500/10 border-rose-400/30 text-rose-100/85'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            {errorCode === 'AUTH' ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <Plug className="w-4 h-4 shrink-0" />
            )}
            <span className="font-medium">
              {errorCode === 'AUTH'
                ? '读取 UFS 权限不足'
                : errorCode === 'NOT_CONNECTED'
                  ? '未连接数据同步组'
                  : '读取 UFS 失败'}
            </span>
            <button
              type="button"
              onClick={() => void loadYears()}
              className="ml-auto px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/80"
            >
              重试
            </button>
          </div>
          <div className="text-white/60 break-all">{error}</div>
          {errorCode === 'AUTH' && (
            <div className="text-white/45 mt-1">
              展开页面底部的「数据同步组」面板检查后端地址与 token；UFS 与目录清单共用同一个组。
            </div>
          )}
        </div>
      )}

      {years === null && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-white/40 gap-3">
          <RefreshCw className="w-6 h-6 animate-spin" />
          <span className="text-sm">读取 UFS 快照…</span>
        </div>
      )}

      {years !== null && years.length === 0 && !error && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-6 text-center space-y-2">
          <Database className="w-8 h-8 text-white/40 mx-auto" />
          <div className="text-white/70">数据组里还没有 UFS 快照</div>
          <div className="text-white/40 text-xs leading-relaxed">
            在 zip-browser 文件浏览器里对某个目录或文件点「+ufs」，快照会写到共用数据组的 {UFS_ROOT}/
            下；写完后回到这里点「刷新」即可看到年份分组与快照树。
          </div>
          <button
            type="button"
            onClick={() => void loadYears()}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm"
          >
            刷新
          </button>
        </div>
      )}

      {/* 年份分组 */}
      {years !== null && years.length > 0 && (
        <div className="space-y-2">
          {years.map((row) => {
            const open = !!openYears[row.year]
            const data = yearData[row.year]
            const loading = !!yearLoading[row.year]
            const sums = data ? summarizeYear(data) : null
            return (
              <div key={row.year} className="rounded-xl bg-white/5 border border-white/10">
                <button
                  type="button"
                  onClick={() => toggleYear(row.year)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 rounded-xl"
                >
                  {open ? (
                    <ChevronDown className="w-4 h-4 text-white/50 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-white/50 shrink-0" />
                  )}
                  <Database className="w-4 h-4 text-sky-300/70 shrink-0" />
                  <span className="text-white/85 font-medium text-sm">{row.year} 年</span>
                  <span className="text-white/40 text-xs">
                    {row.bundles} 个快照{row.legacy > 0 ? ` · ${row.legacy} 条旧格式` : ''}
                  </span>
                  {sums && (
                    <span className="text-sky-200/55 text-[11px] font-mono tabular-nums">
                      {formatCount(sums.files)} 个文件 · {formatSize(sums.size)}
                    </span>
                  )}
                  {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-white/40 ml-auto" />}
                </button>

                {open && (
                  <div className="px-3 pb-3 space-y-2">
                    {loading && !data && <div className="text-white/35 text-xs px-1 py-2">读取快照列表…</div>}
                    {data && data.broken > 0 && (
                      <div className="text-amber-300/70 text-xs px-1">
                        {data.broken} 份快照首行损坏，已跳过
                      </div>
                    )}

                    {data?.bundles.map((card) => {
                      const cardOpen = !!expanded[card.bundlePath]
                      const tree = trees[card.bundlePath]
                      const cardTags = bundleTags[card.bundlePath] || TAG_MAP_EMPTY
                      const src = sourceLabel(card.source)
                      const added = formatMtime(card.addedAt)
                      const nameHit = q.length > 0 && card.name.toLowerCase().includes(q)
                      const treeHit = !!tree?.root && !!filterUfsTree(tree.root, query, cardTags, tagFilter)
                      // 有筛选时：名字命中、或已展开的树里有命中才显示；
                      // 只按标签筛且树还没展开时先保留（内容未知，展开后才能筛）
                      const visible =
                        !q && !tagFilter
                          ? true
                          : nameHit || treeHit || (!!tagFilter && !tree?.root)
                      if (!visible) return null
                      const rootTags = cardTags[''] || []
                      return (
                        <div
                          key={card.bundlePath}
                          className="rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2 space-y-1.5"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <button
                              type="button"
                              onClick={() => toggleBundle(card)}
                              className="shrink-0 text-white/45 hover:text-white"
                              title={cardOpen ? '收起快照树' : '展开快照树（读取整份 bundle）'}
                            >
                              {cardOpen ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {card.type === 'file' ? (
                              <FileIcon className="w-4 h-4 text-white/45 shrink-0" />
                            ) : (
                              <Folder className="w-4 h-4 text-sky-300/70 shrink-0" />
                            )}
                            <span className="text-white/85 text-sm truncate" title={card.name}>
                              {card.name}
                            </span>
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] leading-none bg-white/5 text-white/45">
                              {card.type === 'file' ? '单文件快照' : '目录快照'}
                            </span>
                            {rootTags.length > 0 && (
                              <span className="flex items-center gap-1 flex-wrap">
                                {rootTags.map((t) => (
                                  <UserTagChip
                                    key={t}
                                    tag={t}
                                    active={tagFilter === t}
                                    onClick={() => setTagFilter((p) => (p === t ? null : t))}
                                  />
                                ))}
                              </span>
                            )}
                            <span className="ml-auto shrink-0 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void openTagEditor(card, '')}
                                title={rootTags.length ? `编辑快照根标签（当前：${rootTags.join('、')}）` : '给快照根打标签'}
                                className="text-white/30 hover:text-amber-200 px-1 leading-none"
                              >
                                <Tag className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemove({ path: card.bundlePath, name: card.name })}
                                title="移出 UFS：只删除这份快照索引，不动原目录与本机文件"
                                className="text-white/30 hover:text-red-300 px-1 leading-none"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          </div>

                          <div className="flex items-center gap-2 flex-wrap text-[11px] text-white/40 pl-5">
                            <span className="px-1 py-0.5 rounded bg-white/5 text-white/50">{src.kind}</span>
                            {src.detail && (
                              <span className="font-mono break-all max-w-full" title={src.detail}>
                                {src.detail}
                              </span>
                            )}
                            {added && <span>加入 {added}</span>}
                            {card.summary && (
                              <span className="text-sky-200/55 font-mono tabular-nums">
                                {formatCount(card.summary.files)} 个文件 · {formatSize(card.summary.size)}
                              </span>
                            )}
                            {card.summary?.partial && (
                              <span className="text-amber-300/70 flex items-center gap-0.5">
                                <AlertTriangle className="w-3 h-3" />
                                部分不可读
                              </span>
                            )}
                            {(card.summary?.hashFailed ?? 0) > 0 && (
                              <span className="text-amber-300/70">{card.summary?.hashFailed} 个哈希失败</span>
                            )}
                            <span className="font-mono text-white/25 break-all" title={card.bundlePath}>
                              {card.bundlePath}
                            </span>
                          </div>

                          {cardOpen && (
                            <div className="pl-1">
                              {tree?.loading && <div className="text-white/35 text-xs py-1">读取快照中…</div>}
                              {tree?.error && (
                                <div className="text-rose-300/80 text-xs py-1 flex items-center gap-2">
                                  <span className="break-all">{tree.error}</span>
                                  <button
                                    type="button"
                                    onClick={() => void loadTree(card)}
                                    className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 text-white/70"
                                  >
                                    重试
                                  </button>
                                </div>
                              )}
                              {tree?.root && (
                                <SnapshotTree
                                  root={filterUfsTree(tree.root, query, cardTags, tagFilter)}
                                  tags={cardTags}
                                  forceOpen={!!q || !!tagFilter}
                                  collapseSignal={collapseSignal}
                                  tagFilter={tagFilter}
                                  onTagClick={(t) => setTagFilter((p) => (p === t ? null : t))}
                                  onEditTags={(rel, current) => {
                                    setTagEditor({
                                      key: card.id,
                                      bundleId: card.id,
                                      bundlePath: card.bundlePath,
                                      path: rel,
                                      current,
                                    })
                                  }}
                                  broken={tree.broken}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {data?.legacy.map((entry, i) => (
                      <LegacyRow key={`${entry.path}-${entry.name}-${i}`} entry={entry} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {(q || tagFilter) && years !== null && years.length > 0 && (
        <div className="text-white/30 text-xs">
          搜索 / 标签筛选只覆盖快照名与已展开的树；未展开且名字不匹配的快照已临时隐藏。
        </div>
      )}

      <TagEditorModal
        editor={tagEditor}
        allTags={allTags}
        onClose={() => setTagEditor(null)}
        pathLabel={tagEditor && tagEditor.path === '' ? '（快照根）' : undefined}
        onSave={(next) => {
          if (tagEditor) {
            applyTags(tagEditor.bundleId, tagEditor.bundlePath, tagEditor.path, next)
          }
          setTagEditor(null)
        }}
      />

      {confirmRemove && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => {
            if (!removing) setConfirmRemove(null)
          }}
        >
          <div
            className="w-[min(92vw,420px)] rounded-xl bg-[#1b1f27] border border-white/10 p-4 space-y-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-300/80" />
              <h3 className="text-white/90 font-medium text-sm">移出 UFS</h3>
            </div>
            <div className="text-white/55 text-xs leading-relaxed">
              将删除快照「{confirmRemove.name}」的这一份索引文件：
              <div className="font-mono text-white/40 break-all mt-1">{confirmRemove.path}</div>
              原始目录与本机文件不受影响；已打的标签文件保留。
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={removing}
                onClick={() => setConfirmRemove(null)}
                className="px-3 py-1.5 rounded-lg bg-white/5 text-white/70 hover:bg-white/15 text-sm disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={removing}
                onClick={() => void doRemove()}
                className="px-3 py-1.5 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-sm disabled:opacity-50"
              >
                {removing ? '删除中…' : '移出'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 已加载年份的快照统计（按 meta.summary 累加） */
function summarizeYear(data: UfsYearData): { files: number; size: number } {
  let files = 0
  let size = 0
  for (const b of data.bundles) {
    files += b.summary?.files ?? 0
    size += b.summary?.size ?? 0
  }
  return { files, size }
}

/** 旧格式分片条目：只能列，不能展开（没有节点快照） */
function LegacyRow({ entry }: { entry: UfsLegacyEntry }) {
  const src = sourceLabel(entry.source)
  const added = formatMtime(entry.addedAt)
  return (
    <div className="rounded-lg bg-white/[0.02] border border-dashed border-white/10 px-2.5 py-1.5 text-xs flex items-center gap-2 flex-wrap">
      {entry.type === 'file' ? (
        <FileIcon className="w-3.5 h-3.5 text-white/40 shrink-0" />
      ) : (
        <Folder className="w-3.5 h-3.5 text-white/40 shrink-0" />
      )}
      <span className="text-white/70 truncate" title={entry.name}>
        {entry.name}
      </span>
      <span className="px-1 py-0.5 rounded bg-white/5 text-white/45">{src.kind}</span>
      {src.detail && <span className="font-mono text-white/35 break-all">{src.detail}</span>}
      {added && <span className="text-white/35">加入 {added}</span>}
      <span className="text-amber-300/60">旧格式分片 · 无节点快照，不能展开</span>
    </div>
  )
}

/** 只读快照树：持有展开状态（rel → open），行内自行分页 */
function SnapshotTree({
  root,
  tags,
  forceOpen,
  collapseSignal,
  tagFilter,
  onTagClick,
  onEditTags,
  broken,
}: {
  root: UfsTreeNode | null
  tags: Record<string, string[]>
  forceOpen: boolean
  collapseSignal: number
  tagFilter: string | null
  onTagClick: (tag: string) => void
  onEditTags: (rel: string, current: string[]) => void
  broken?: number
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setOpen({})
  }, [collapseSignal])

  if (!root) {
    return <div className="text-white/30 text-xs px-1 py-1">无匹配的节点</div>
  }

  const toggleRel = (rel: string) => {
    setOpen((s) => ({ ...s, [rel]: !isOpenRel(s, rel) }))
  }

  return (
    <div className="pt-1">
      {broken ? (
        <div className="text-amber-300/60 text-[11px] px-2 pb-1">{broken} 行节点解析失败，已跳过</div>
      ) : null}
      <Row
        node={root}
        depth={0}
        open={open}
        forceOpen={forceOpen}
        toggleRel={toggleRel}
        tags={tags}
        tagFilter={tagFilter}
        onTagClick={onTagClick}
        onEditTags={onEditTags}
      />
    </div>
  )
}

/** 展开判定：外层根默认展开；筛选时全部强制展开 */
function isOpenRel(open: Record<string, boolean>, rel: string): boolean {
  const value = open[rel]
  if (value === undefined) return rel === ''
  return value
}

/** 树行：目录可展开，文件只读；每行右侧标签按钮 */
function Row({
  node,
  depth,
  open,
  forceOpen,
  toggleRel,
  tags,
  tagFilter,
  onTagClick,
  onEditTags,
}: {
  node: UfsTreeNode
  depth: number
  open: Record<string, boolean>
  forceOpen: boolean
  toggleRel: (rel: string) => void
  tags: Record<string, string[]>
  tagFilter: string | null
  onTagClick: (tag: string) => void
  onEditTags: (rel: string, current: string[]) => void
}) {
  const [shown, setShown] = useState(PAGE)
  const [copied, setCopied] = useState(false)
  const ownTags = tags[node.rel] || []
  const hasChildren = node.type === 'dir' && node.children.length > 0
  const opened = forceOpen || isOpenRel(open, node.rel)
  const indent = { paddingLeft: `${depth * 14 + 8}px` }
  const mtime = formatMtime(node.mtime)

  const copyHash = async () => {
    if (!node.hash) return
    try {
      await navigator.clipboard.writeText(node.hash)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  return (
    <div>
      <div className="group flex items-center gap-1 py-1 pr-2 rounded hover:bg-white/5" style={indent}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => toggleRel(node.rel)}
            className={`shrink-0 ${forceOpen ? 'text-white/30' : 'text-white/45 hover:text-white'}`}
            title={opened ? '收起' : '展开'}
          >
            {opened ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {node.type === 'file' ? (
          <FileIcon className="w-4 h-4 text-white/45 shrink-0" />
        ) : opened && hasChildren ? (
          <FolderOpen className="w-4 h-4 text-sky-300/70 shrink-0" />
        ) : (
          <Folder className="w-4 h-4 text-sky-300/70 shrink-0" />
        )}
        <span className="text-white/75 text-sm truncate" title={node.rel || node.name}>
          {node.name}
        </span>
        {node.synth && (
          <span
            className="shrink-0 px-1 py-0.5 rounded text-[10px] leading-none bg-white/5 text-white/35"
            title="快照里缺这个父目录，按子节点路径补出来的占位目录"
          >
            补
          </span>
        )}

        {node.type === 'dir' ? (
          <span
            className="ml-1 shrink-0 text-sky-200/55 text-[11px] font-mono tabular-nums leading-none whitespace-nowrap"
            title={`文件 ${node.fileCount ?? 0} 个 · 共 ${node.totalSize ?? 0} 字节`}
          >
            {node.partialTree ? '≥' : ''}
            {formatCount(node.fileCount ?? 0)} 项 · {formatSize(node.totalSize ?? 0)}
          </span>
        ) : (
          <span className="ml-1 shrink-0 text-white/45 text-[11px] font-mono tabular-nums leading-none whitespace-nowrap">
            {formatSize(node.size)}
            {node.hashError && (
              <span className="text-amber-300/70" title={node.hashError}>
                {' · 哈希失败'}
              </span>
            )}
          </span>
        )}

        {node.type === 'file' && node.hash && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void copyHash()
            }}
            title={`SHA-256：${node.hash}（点击复制）`}
            className="shrink-0 flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-mono leading-none bg-white/5 text-white/35 hover:text-white/70 hover:bg-white/10"
          >
            <Hash className="w-3 h-3" />
            {copied ? '已复制' : node.hash.slice(0, 8)}
          </button>
        )}

        {mtime && (
          <span
            className="shrink-0 text-white/30 text-[11px] font-mono tabular-nums leading-none whitespace-nowrap"
            title={`最后修改 ${mtime}`}
          >
            改 {mtime}
          </span>
        )}

        {node.partial && (
          <span className="shrink-0 px-1 py-0.5 rounded text-[10px] leading-none bg-amber-500/15 text-amber-200/80">
            部分不可读
          </span>
        )}

        {ownTags.length > 0 && (
          <span className="flex items-center gap-1 flex-wrap ml-1">
            {ownTags.map((t) => (
              <UserTagChip key={t} tag={t} active={tagFilter === t} onClick={() => onTagClick(t)} />
            ))}
          </span>
        )}

        <span className="ml-auto shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onEditTags(node.rel, ownTags)
            }}
            title={ownTags.length ? `编辑标签（当前：${ownTags.join('、')}）` : '给该条目打标签'}
            className="shrink-0 text-white/30 hover:text-amber-200 px-1 leading-none"
          >
            <Tag className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>

      {opened && hasChildren && (
        <div>
          {node.children.slice(0, shown).map((child) => (
            <Row
              key={child.rel}
              node={child}
              depth={depth + 1}
              open={open}
              forceOpen={forceOpen}
              toggleRel={toggleRel}
              tags={tags}
              tagFilter={tagFilter}
              onTagClick={onTagClick}
              onEditTags={onEditTags}
            />
          ))}
          {node.children.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="text-white/40 hover:text-white/80 text-xs py-1"
              style={{ paddingLeft: `${(depth + 1) * 14 + 26}px` }}
            >
              显示更多（剩余 {node.children.length - shown}）
            </button>
          )}
        </div>
      )}
    </div>
  )
}
