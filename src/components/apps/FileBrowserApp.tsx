// 文件浏览器应用 UI 层。
// 状态机：loading / error（含「去连接」引导）/ empty / data。
// 手动刷新（与设备监控一致，无自动刷新）；多主机并列展示各自的只读目录树；
// 关键词筛选文件/文件夹（命中节点 + 祖先链），命中时整棵匹配树自动展开；文件夹标签小徽标；
// 每个条目可打用户标签，独立存于 <base>/file-tags/（不改写 struct 清单）；
// 带 'private' 标签的目录缺省隐藏且不显示任何提示（静默），在页面键入 magic code
// 切换显示/隐藏（键盘序列，无输入框）；解锁后的状态提示可点击，直接切回隐藏态。
// 磁盘行（盘符，depth=0）悬浮显示卷信息卡片：卷标识、挂载主机、统计、分片来源、标签等。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Server,
  RefreshCw,
  Search,
  Folder,
  FolderOpen,
  FolderTree as FolderTreeIcon,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Plug,
  FileWarning,
  File,
  Tag,
  Eye,
  HardDrive,
  Trash2,
  ChevronsDownUp,
} from 'lucide-react'
import {
  fetchDirStructManifests,
  getFolderDeepenMarks,
  putFolderDeepenMarks,
  getFileTags,
  putFileTags,
  deleteHostManifest,
  deleteDriveShards,
  RsNotConnectedError,
  RsAuthError,
} from './filebrowser/fetch'
import FileBrowserSyncPanel from './filebrowser/FileBrowserSyncPanel'
import { filterTree, normalizeManifests, countTaggedNodes } from './filebrowser/normalize'
import { volumeSerialInfo } from './filebrowser/volumeSerial'
import type { FileNodeView, FolderNodeView, FsNodeView, ManifestView } from './filebrowser/types'

type LoadState = 'loading' | 'error' | 'empty' | 'data'

// 隐私目录：标签为 'private'（大小写不敏感）的目录缺省隐藏；
// 在页面任意处依次键入此 magic code（键盘序列，无需输入框）即切换显示/隐藏。
const PRIVATE_TAG = 'private'
const MAGIC_CODE = 'wwssadadba'

export default function FileBrowserApp() {
  const [state, setState] = useState<LoadState>('loading')
  const [manifests, setManifests] = useState<ManifestView[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [query, setQuery] = useState('')
  // 清单基目录已下沉到同步后端配置；这里不再维护可编辑的基目录。
  // 深挖标记：key（volumeId 或 主机::盘符）→ 该盘下被标记 host-relative 路径集合
  const [marksByKey, setMarksByKey] = useState<Record<string, Set<string>>>({})
  // 用户标签：key（与深挖标记同一命名空间）→ host-relative 路径 → 标签数组
  const [tagsByKey, setTagsByKey] = useState<Record<string, Record<string, string[]>>>({})
  // 标签筛选：点击标签芯片时按该标签过滤整棵树；null 表示不按标签筛。
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  // 目录大小筛选：控件状态（比较方向 / 阈值数值 / 单位）与已应用的条件（字节）。
  // 仅点「应用」后才生效，避免输入过程中反复重算整棵树。
  const [sizeOp, setSizeOp] = useState<'gt' | 'lt'>('gt')
  const [sizeValue, setSizeValue] = useState('500')
  const [sizeUnit, setSizeUnit] = useState<'MB' | 'GB'>('MB')
  const [sizeFilter, setSizeFilter] = useState<{ op: 'gt' | 'lt'; bytes: number } | null>(null)
  // 标签编辑弹窗状态：null 表示关闭；非空携带所在盘的命名空间与 host-relative 路径与当前标签。
  const [tagEditor, setTagEditor] = useState<{ key: string; path: string; current: string[] } | null>(
    null,
  )
  // 隐私目录：缺省隐藏（带 'private' 标签的目录）；键入 magic code 解锁，点击状态提示即可重新隐藏。
  const [showPrivate, setShowPrivate] = useState(false)
  // 键盘序列缓冲：记录最近键入的字符，凑齐 MAGIC_CODE 即切换（无需任何输入框）。
  const magicBuf = useRef('')
  // 「全部收起」信号：每次自增让所有 FolderTree 收回顶层；筛选强制展开除外。
  const [collapseSignal, setCollapseSignal] = useState(0)
  // 删除确认弹窗：null 关闭；非空携带待删主机/盘符信息与待删文件清单。
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: 'host' | 'drive'
    title: string
    files: string[]
    hostSource?: string
    driveName?: string
    indexBase?: string
    shardBases?: string[]
    shardGroups?: string[][]
  } | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const isTextInput = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null
      const tag = el?.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable === true
      )
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // 组合键、或在文本输入控件内（搜索框 / 基目录 / 标签编辑）不参与序列，避免误触。
      if (e.ctrlKey || e.metaKey || e.altKey || isTextInput(e.target)) {
        magicBuf.current = ''
        return
      }
      // 辅助键不改变字符序列，忽略；其余非单字符键（方向键 / Enter / Backspace…）中断序列。
      if (e.key === 'Shift' || e.key === 'CapsLock') return
      if (e.key.length !== 1) {
        magicBuf.current = ''
        return
      }
      const next = (magicBuf.current + e.key.toLowerCase()).slice(-MAGIC_CODE.length)
      magicBuf.current = next
      if (next === MAGIC_CODE) {
        magicBuf.current = ''
        setShowPrivate((p) => !p)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 切回隐藏态：清空键盘序列缓冲，并移除 'private' 标签筛选，
  // 避免锁定后仍残留「存在隐私目录」的痕迹（锁定态必须完全静默）。
  const hidePrivate = useCallback(() => {
    magicBuf.current = ''
    setShowPrivate(false)
    setTagFilter((prev) => (prev?.toLowerCase() === PRIVATE_TAG ? null : prev))
  }, [])

  const load = useCallback(async () => {
    setState('loading')
    setErrorMsg('')
    setErrorCode('')
    try {
      const raws = await fetchDirStructManifests()
      const ms = normalizeManifests(raws)
      setManifests(ms)
      // 并发加载每台主机每个驱动的深挖标记与用户标签（按卷身份命名空间）。
      const marks: Record<string, Set<string>> = {}
      const tags: Record<string, Record<string, string[]>> = {}
      await Promise.all(
        ms.map(async (m) => {
          for (const drive of m.root.children) {
            if (drive.type !== 'folder') continue
            const key = drive.volumeId || `${m.source}::${drive.name}`
            try {
              const list = await getFolderDeepenMarks(key)
              if (list.length) marks[key] = new Set(list)
            } catch (err) {
              // 标记读取失败（如令牌缺权限）不阻断浏览，写回时再提示
              if (err instanceof RsAuthError) {
                console.warn('[filebrowser] 读取深挖标记权限不足，写回时会提示:', err.message)
              }
            }
            try {
              const map = await getFileTags(key)
              if (Object.keys(map).length) tags[key] = map
            } catch (err) {
              // 标签读取失败同样不阻断浏览
              if (err instanceof RsAuthError) {
                console.warn('[filebrowser] 读取用户标签权限不足，写回时会提示:', err.message)
              }
            }
          }
        }),
      )
      setMarksByKey(marks)
      setTagsByKey(tags)
      setState(ms.length > 0 ? 'data' : 'empty')
    } catch (e) {
      if (e instanceof RsAuthError) {
        setErrorCode('AUTH')
        setErrorMsg(e.message)
      } else if (e instanceof RsNotConnectedError) {
        setErrorCode(e.code)
        setErrorMsg(e.message)
      } else {
        setErrorCode('UNKNOWN')
        setErrorMsg(e instanceof Error ? e.message : String(e))
      }
      setState('error')
    }
  }, [])

  // 切换某目录的深挖标记并写回 RS（按卷身份命名空间去重）。
  const toggleMark = useCallback((key: string, path: string) => {
    setMarksByKey((prev) => {
      const cur = prev[key] || new Set<string>()
      const next = new Set(cur)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      const m = { ...prev }
      if (next.size) m[key] = next
      else delete m[key]
      // 写回放到微任务里，避免在状态更新函数内做副作用
      queueMicrotask(() => {
        putFolderDeepenMarks(key, [...next]).catch((err) => {
          console.error('[filebrowser] 写回深挖标记失败:', err)
        })
      })
      return m
    })
  }, [])

  // 设置某条目的用户标签并写回 RS（空数组表示删除该条目标签）。
  const setNodeTags = useCallback((key: string, path: string, tags: string[]) => {
    setTagsByKey((prev) => {
      const cur = prev[key] || {}
      const next = { ...cur }
      const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
      if (cleaned.length) next[path] = cleaned
      else delete next[path]
      const m = { ...prev }
      if (Object.keys(next).length) m[key] = next
      else delete m[key]
      // 写回放到微任务里，避免在状态更新函数内做副作用
      queueMicrotask(() => {
        putFileTags(key, next).catch((err) => {
          console.error('[filebrowser] 写回用户标签失败:', err)
        })
      })
      return m
    })
  }, [])

  // 确认删除：走数据组 deleteFile（墓碑 + 自动同步），完成后刷新清单。
  const confirmDeleteAndRun = useCallback(async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      if (confirmDelete.kind === 'host') {
        await deleteHostManifest(confirmDelete.indexBase, confirmDelete.shardGroups ?? [])
      } else {
        await deleteDriveShards(confirmDelete.shardBases ?? [])
      }
      setConfirmDelete(null)
      await load()
    } catch (e) {
      if (e instanceof RsAuthError) setErrorCode('AUTH')
      else if (e instanceof RsNotConnectedError) setErrorCode(e.code)
      else setErrorCode('UNKNOWN')
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setConfirmDelete(null)
    } finally {
      setDeleting(false)
    }
  }, [confirmDelete, load])
  const applySizeFilter = () => {
    const v = Number(sizeValue)
    if (!isFinite(v) || v <= 0) {
      setSizeFilter(null)
      return
    }
    const unitBytes = sizeUnit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024
    setSizeFilter({ op: sizeOp, bytes: v * unitBytes })
  }

  useEffect(() => {
    void load()
  }, [load])

  const totalMarks = useMemo(
    () => Object.values(marksByKey).reduce((s, set) => s + set.size, 0),
    [marksByKey],
  )

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const hidePrivate = !showPrivate
    if (!q && !tagFilter && !hidePrivate && !sizeFilter) return manifests
    return manifests
      .map((m) => {
        const root = filterTree(m.root, q, {
          tag: tagFilter,
          source: m.source,
          userTagsByKey: tagsByKey,
          basePath: [],
          hidePrivate,
          sizeFilter,
        })
        return root ? { ...m, root } : null
      })
      .filter((m): m is ManifestView => m !== null)
  }, [manifests, q, tagFilter, tagsByKey, showPrivate, sizeFilter])

  // 隐私目录总数：仅供解锁态的状态提示使用（锁定态不渲染任何相关信息）。
  const privateCount = useMemo(
    () => countTaggedNodes(manifests, PRIVATE_TAG, tagsByKey),
    [manifests, tagsByKey],
  )

  const totalFolders = useMemo(
    () => manifests.reduce((s, m) => s + m.folderCount, 0),
    [manifests],
  )

  // 全部已用过的用户标签（用于编辑弹窗的「建议已有标签」）。
  const allUserTags = useMemo(() => {
    const s = new Set<string>()
    for (const perKey of Object.values(tagsByKey)) {
      for (const arr of Object.values(perKey)) {
        for (const t of arr) s.add(t)
      }
    }
    return [...s].sort()
  }, [tagsByKey])

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-white/90 font-medium flex items-center gap-2">
          <FolderTreeIcon className="w-4 h-4 text-white/50" />
          文件浏览器
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapseSignal((v) => v + 1)}
            title="收起全部目录（筛选命中时仍保持展开）"
            className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/70 hover:bg-white/15 hover:text-white flex items-center gap-1.5 transition-colors"
          >
            <ChevronsDownUp className="w-3.5 h-3.5" />
            全部收起
          </button>
          <button
            onClick={load}
            className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/70 hover:bg-white/15 hover:text-white flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </button>
        </div>
      </div>

      <FileBrowserSyncPanel onReady={() => void load()} />

      {state === 'data' && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-white/45 text-xs">{manifests.length} 台主机</span>
          <span className="text-white/45 text-xs">{totalFolders} 个文件夹</span>
          {/* 仅在「已解锁、隐私目录确实可见」时才暴露隐私相关状态；锁定态完全静默。
              点击该状态即切回隐藏态，无需再次键入 magic code。 */}
          {showPrivate && privateCount > 0 && (
            <button
              type="button"
              onClick={hidePrivate}
              title="点击重新隐藏隐私目录（也可再次键入 magic code 切换）"
              className="group flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-emerald-200/85 transition-colors hover:bg-emerald-500/15 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/50"
            >
              <Eye className="w-3.5 h-3.5" />
              隐私已显示
              <span className="hidden group-hover:inline text-emerald-200/60">· 点击隐藏</span>
            </button>
          )}
          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 text-white/35 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选文件/文件夹…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/85 text-sm placeholder:text-white/30 outline-none focus:border-white/25"
            />
          </div>
        </div>
      )}

      {state === 'data' && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-white/45">目录大小</span>
          <select
            value={sizeOp}
            onChange={(e) => setSizeOp(e.target.value as 'gt' | 'lt')}
            title="比较方向"
            className="px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-white/80 outline-none focus:border-white/25"
          >
            <option value="gt" className="bg-slate-800 text-white/85">大于</option>
            <option value="lt" className="bg-slate-800 text-white/85">小于</option>
          </select>
          <input
            value={sizeValue}
            onChange={(e) => setSizeValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applySizeFilter() }}
            inputMode="decimal"
            placeholder="500"
            title="阈值数值"
            className="w-20 px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white/85 outline-none focus:border-white/25"
          />
          <select
            value={sizeUnit}
            onChange={(e) => setSizeUnit(e.target.value as 'MB' | 'GB')}
            title="单位（1024 进制）"
            className="px-2 py-1 rounded-lg bg-slate-800 border border-white/10 text-white/80 outline-none focus:border-white/25"
          >
            <option value="MB" className="bg-slate-800 text-white/85">MB</option>
            <option value="GB" className="bg-slate-800 text-white/85">GB</option>
          </select>
          <button
            type="button"
            onClick={applySizeFilter}
            className="px-2.5 py-1 rounded-lg bg-sky-500/20 text-sky-100/90 hover:bg-sky-500/30 transition-colors"
          >
            应用
          </button>
          {sizeFilter && (
            <button
              type="button"
              onClick={() => setSizeFilter(null)}
              className="text-white/40 hover:text-white"
            >
              清除
            </button>
          )}
          <span className="text-white/30">仅统计过大小的目录参与；与关键词/标签为「或」关系</span>
        </div>
      )}

      {state === 'data' && sizeFilter && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-white/45">大小筛选：</span>
          <button
            type="button"
            onClick={() => setSizeFilter(null)}
            className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-100/90 ring-1 ring-sky-400/30 flex items-center gap-1 hover:bg-sky-500/30"
          >
            目录 {sizeFilter.op === 'gt' ? '大于' : '小于'} {formatSize(sizeFilter.bytes)}
            <span className="leading-none">✕</span>
          </button>
          <button type="button" onClick={() => setSizeFilter(null)} className="text-white/40 hover:text-white">
            清除
          </button>
        </div>
      )}

      {state === 'data' && totalMarks > 0 && (
        <div className="rounded-lg bg-sky-500/10 border border-sky-400/25 px-3 py-2 text-xs text-sky-100/85 leading-relaxed">
          ↳ 已标记 {totalMarks} 个目录「继续解析下一层」。标记后需在本机重新运行 dir-struct-gen 生成清单，再点「刷新」才会展开。
        </div>
      )}

      {state === 'data' && tagFilter && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-white/45">标签筛选：</span>
          <button
            onClick={() => setTagFilter(null)}
            className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200/90 ring-1 ring-amber-400/30 flex items-center gap-1 hover:bg-amber-500/30"
          >
            {tagFilter}
            <span className="leading-none">✕</span>
          </button>
          <button onClick={() => setTagFilter(null)} className="text-white/40 hover:text-white">
            清除
          </button>
        </div>
      )}

      {/* 锁定态不显示任何提示（否则等于宣告「这里藏了 N 个目录」）；仅解锁后给一条状态提示。 */}
      {state === 'data' && showPrivate && privateCount > 0 && (
        <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed bg-emerald-500/10 border-emerald-400/25 text-emerald-100/85">
          {`🔓 已显示 ${privateCount} 个隐私目录（含 'private' 标签）。`}
          <button
            type="button"
            onClick={hidePrivate}
            className="mx-1 underline decoration-emerald-300/40 underline-offset-2 hover:text-white hover:decoration-emerald-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/50 rounded"
          >
            重新隐藏
          </button>
          {'，或再次键入 magic code 切换。'}
        </div>
      )}

      {state === 'loading' && <LoadingState />}
      {state === 'error' && <ErrorState code={errorCode} message={errorMsg} onRetry={load} />}
      {state === 'empty' && <EmptyState onRetry={load} />}
      {state === 'data' &&
        (filtered.length === 0 ? (
          <div className="text-white/30 text-sm text-center py-8">
            {q || tagFilter || sizeFilter ? '无匹配的文件或文件夹' : '/struct 下暂无目录结构清单'}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((m) => (
              <HostCard
                key={m.source}
                manifest={m}
                query={q}
                marksByKey={marksByKey}
                tagsByKey={tagsByKey}
                tagFilter={tagFilter}
                sizeActive={!!sizeFilter}
                collapseSignal={collapseSignal}
                onToggleMark={toggleMark}
                onSetTags={setNodeTags}
                onTagClick={(t) => setTagFilter((prev) => (prev === t ? null : t))}
                onEditTags={(key, path, current) => setTagEditor({ key, path, current })}
                onRequestDeleteHost={() => {
                  const shardGroups = m.root.children
                    .filter((c): c is FolderNodeView => c.type === 'folder')
                    .map((c) => c.shardBases ?? [])
                  const shardBases = shardGroups.flat()
                  setConfirmDelete({
                    kind: 'host',
                    title: `删除主机「${m.root.name}」的全部清单数据`,
                    files: [
                      ...(m.indexBase ? [`${m.indexBase}.json`] : []),
                      ...shardBases.map((b) => `${b}.json`),
                    ],
                    hostSource: m.source,
                    indexBase: m.indexBase,
                    shardBases,
                    shardGroups,
                  })
                }}
                onRequestDeleteDrive={(drive) => {
                  const bases = drive.shardBases ?? []
                  if (!bases.length) return
                  setConfirmDelete({
                    kind: 'drive',
                    title: `删除盘符「${drive.name}」的清单分片`,
                    files: bases.map((b) => `${b}.json`),
                    hostSource: m.source,
                    driveName: drive.name,
                    shardBases: bases,
                  })
                }}
              />
            ))}
          </div>
        ))}

      <TagEditorModal
        editor={tagEditor}
        allTags={allUserTags}
        onClose={() => setTagEditor(null)}
        onSave={(next) => {
          if (tagEditor) setNodeTags(tagEditor.key, tagEditor.path, next)
          setTagEditor(null)
        }}
      />

      <DeleteConfirmModal
        confirm={confirmDelete}
        deleting={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={confirmDeleteAndRun}
      />
    </div>
  )
}

// ── 状态小组件 ──

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-white/40 gap-3">
      <RefreshCw className="w-6 h-6 animate-spin" />
      <span className="text-sm">加载中…</span>
    </div>
  )
}

function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-6 text-center space-y-3">
      <FolderTreeIcon className="w-8 h-8 text-white/40 mx-auto" />
      <div className="text-white/70">/struct 下暂无目录结构清单</div>
      <div className="text-white/40 text-xs">
        确认生成端已向当前同步组写入主机目录清单（每台主机一个 .json）后重试；
        后端基准路径在同步组面板里配置。
      </div>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm"
      >
        重试
      </button>
    </div>
  )
}

function ErrorState({ code, message, onRetry }: { code: string; message: string; onRetry: () => void }) {
  // 后端已连接、但当前凭据缺目录权限（服务端 401/403）——需检查后端地址与 token。
  if (code === 'AUTH') {
    return (
      <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 p-6 text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-amber-300/80 mx-auto" />
        <div className="text-amber-100">目录权限不足</div>
        <div className="text-white/55 text-sm leading-relaxed">
          同步后端已连接，但凭据缺少对应目录的读权限（服务端返回 401/403），
          因此无法读取目录结构清单。
        </div>
        <div className="text-white/45 text-xs leading-relaxed text-left mx-auto max-w-sm">
          解决：展开上方「数据同步组」面板，检查后端地址、Bearer token 与基准路径是否正确，
          必要时重新填写后点「刷新」。
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={onRetry}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm"
          >
            刷新
          </button>
        </div>
      </div>
    )
  }
  if (code === 'NOT_CONNECTED') {
    return (
      <div className="rounded-xl bg-white/5 border border-white/10 p-6 text-center space-y-3">
        <Plug className="w-8 h-8 text-white/40 mx-auto" />
        <div className="text-white/80">未连接数据同步组</div>
        <div className="text-white/45 text-sm">
          无法读取目录结构清单。请在上方「数据同步组」面板配置并连接一个含远端后端的组后，点「重试」。
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={onRetry}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm"
          >
            重试
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-rose-500/10 border border-rose-400/30 p-6 text-center space-y-3">
      <AlertTriangle className="w-8 h-8 text-rose-400/70 mx-auto" />
      <div className="text-rose-200">加载失败</div>
      <div className="text-white/45 text-sm break-all">{message}</div>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm"
      >
        重试
      </button>
    </div>
  )
}

// ── 主机卡片 + 目录树 ──

function formatGeneratedAt(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function TagChip({
  tag,
  active,
  onClick,
}: {
  tag: string
  active?: boolean
  onClick?: () => void
}) {
  const cls = `px-1.5 py-0.5 rounded text-[10px] font-mono leading-none ${
    active
      ? 'bg-indigo-500/35 text-indigo-100 ring-1 ring-indigo-300/50'
      : 'bg-indigo-500/15 text-indigo-200/90'
  }`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={(e) => { e.stopPropagation(); onClick() }}>
        {tag}
      </button>
    )
  }
  return <span className={cls}>{tag}</span>
}

// 用户自定义标签：琥珀色，与清单自带（indigo）标签区分；可点击切换标签筛选。
function UserTagChip({
  tag,
  active,
  onClick,
}: {
  tag: string
  active?: boolean
  onClick?: () => void
}) {
  const cls = `px-1.5 py-0.5 rounded text-[10px] font-mono leading-none ${
    active
      ? 'bg-amber-500/35 text-amber-100 ring-1 ring-amber-300/50'
      : 'bg-amber-500/15 text-amber-200/90 ring-1 ring-amber-400/20'
  }`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={(e) => { e.stopPropagation(); onClick() }}>
        {tag}
      </button>
    )
  }
  return <span className={cls}>{tag}</span>
}

// 标签编辑弹窗：当前标签以可删除芯片展示；输入框回车/逗号加标签；建议整棵树已有标签。
function TagEditorModal({
  editor,
  allTags,
  onClose,
  onSave,
}: {
  editor: { key: string; path: string; current: string[] } | null
  allTags: string[]
  onClose: () => void
  onSave: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState<string[]>(editor?.current ?? [])
  const [input, setInput] = useState('')

  useEffect(() => {
    setDraft(editor?.current ?? [])
    setInput('')
  }, [editor])

  if (!editor) return null

  const addTag = (raw: string) => {
    const t = raw.trim()
    if (!t || draft.includes(t)) {
      setInput('')
      return
    }
    setDraft((d) => [...d, t])
    setInput('')
  }
  const removeTag = (t: string) => setDraft((d) => d.filter((x) => x !== t))
  const suggestions = allTags.filter((t) => !draft.includes(t))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-[min(92vw,420px)] rounded-xl bg-[#1b1f27] border border-white/10 p-4 space-y-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white/90 font-medium text-sm">编辑标签</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-white/40 hover:text-white text-sm leading-none"
          >
            ✕
          </button>
        </div>
        <div className="text-white/40 text-xs font-mono break-all">路径：{editor.path}</div>

        <div className="flex flex-wrap gap-1.5 min-h-[24px]">
          {draft.length === 0 && <span className="text-white/30 text-xs">暂无标签</span>}
          {draft.map((t) => (
            <span
              key={t}
              className="px-1.5 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/20 flex items-center gap-1"
            >
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                className="text-amber-200/70 hover:text-white leading-none"
              >
                ✕
              </button>
            </span>
          ))}
        </div>

        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addTag(input)
            } else if (e.key === 'Backspace' && !input && draft.length) {
              removeTag(draft[draft.length - 1])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
          placeholder="输入标签后回车或逗号添加…"
          className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/85 text-sm outline-none focus:border-white/25"
        />

        {suggestions.length > 0 && (
          <div>
            <div className="text-white/35 text-xs mb-1">建议（已有标签）</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => addTag(t)}
                  className="px-1.5 py-0.5 rounded text-[11px] bg-white/5 text-white/60 hover:bg-white/15 hover:text-white"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-white/5 text-white/70 hover:bg-white/15 text-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="px-3 py-1.5 rounded-lg bg-amber-500/80 hover:bg-amber-500 text-white text-sm"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// 字节数 → 人类可读（KB/MB/GB…），用于展示目录总大小。
function formatSize(bytes?: number): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}

// 文件数 → 千分位展示。
function formatCount(n?: number): string {
  if (n == null) return '—'
  return n.toLocaleString('zh-CN')
}

// 目录自身磁盘修改时间（mtime，毫秒级 epoch）→ 简短日期；用于展示「最后改于」。
function formatMtime(ms?: number): string | null {
  if (ms == null || !isFinite(ms)) return null
  const d = new Date(ms)
  if (isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${hh}:${mi}`
}

// 目录大小徽标：展示该目录（含子孙）的文件数、逻辑大小、占用空间。
// 数据来自 dir-struct-gen「汇总文件数与大小」（可选字段，缺失清单不显示）。
// 子树有读不到的部分时 sizePartial=true，以「≥」表示数值只是下界。
function FolderSize({ node }: { node: FolderNodeView }) {
  const hasCount = node.fileCount !== undefined
  const hasSize = node.totalSize !== undefined
  const hasDisk = node.totalSizeOnDisk !== undefined
  if (!hasCount && !hasSize && !hasDisk) return null

  const parts: string[] = []
  if (hasCount) parts.push(`${formatCount(node.fileCount)} 项`)
  if (hasSize) parts.push(formatSize(node.totalSize))
  // 占用与逻辑大小不同（簇对齐 / 压缩 / 稀疏文件等）时才额外标注，避免默认噪声；
  // Windows 下取不到真实占用会按逻辑大小替代，此时两者相等、不重复显示。
  const diskDiffers = hasDisk && (!hasSize || node.totalSizeOnDisk !== node.totalSize)

  const titleParts: string[] = []
  if (hasCount) titleParts.push(`文件 ${node.fileCount} 个`)
  if (hasSize) titleParts.push(`逻辑大小 ${node.totalSize} 字节`)
  if (hasDisk) titleParts.push(`占用空间 ${node.totalSizeOnDisk} 字节`)
  if (node.sizePartial) titleParts.push('（下界：子树有部分无法读取）')
  const mtimeStr = formatMtime(node.mtime)
  if (mtimeStr) titleParts.push(`最后修改 ${mtimeStr}`)

  const main = parts.join(' · ')
  return (
    <span
      className="ml-1 shrink-0 text-sky-200/55 text-[11px] font-mono tabular-nums leading-none whitespace-nowrap"
      title={titleParts.join(' · ')}
    >
      {node.sizePartial ? '≥' : ''}
      {main}
      {diskDiffers && (
        <span className="text-white/35">
          {main ? ' · ' : ''}占 {formatSize(node.totalSizeOnDisk)}
        </span>
      )}
    </span>
  )
}

// 文件大小徽标：展示单个文件的大小与占用空间（有则显示）。
function FileSize({ node }: { node: FileNodeView }) {
  const hasSize = node.size !== undefined
  const hasDisk = node.sizeOnDisk !== undefined
  if (!hasSize && !hasDisk) return null

  const titleParts: string[] = []
  if (hasSize) titleParts.push(`逻辑大小 ${node.size} 字节`)
  if (hasDisk) titleParts.push(`占用空间 ${node.sizeOnDisk} 字节`)
  const mtimeStr = formatMtime(node.mtime)
  if (mtimeStr) titleParts.push(`最后修改 ${mtimeStr}`)

  const diskDiffers = hasDisk && (!hasSize || node.sizeOnDisk !== node.size)
  return (
    <span
      className="ml-1 shrink-0 text-white/45 text-[11px] font-mono tabular-nums leading-none whitespace-nowrap"
      title={titleParts.join(' · ')}
    >
      {hasSize ? formatSize(node.size) : '—'}
      {diskDiffers && <span className="text-white/30"> · 占 {formatSize(node.sizeOnDisk)}</span>}
    </span>
  )
}

// 主机级汇总：累加各「驱动（盘符）」节点的递归统计（盘符互为兄弟、不嵌套，不会重复计数）。
function hostStats(root: FolderNodeView): {
  files: number
  bytes: number
  disk: number
  has: boolean
  hasDisk: boolean
} {
  let files = 0
  let bytes = 0
  let disk = 0
  let has = false
  let hasDisk = false
  for (const d of root.children) {
    if (d.type !== 'folder') continue
    if (d.fileCount !== undefined) {
      files += d.fileCount
      has = true
    }
    if (d.totalSize !== undefined) {
      bytes += d.totalSize
      has = true
    }
    if (d.totalSizeOnDisk !== undefined) {
      disk += d.totalSizeOnDisk
      hasDisk = true
    }
  }
  return { files, bytes, disk, has, hasDisk }
}

const EMPTY_SET: Set<string> = new Set()
const EMPTY_TAGS_MAP: Record<string, string[]> = {}

function HostCard({
  manifest,
  query,
  marksByKey,
  tagsByKey,
  tagFilter,
  sizeActive,
  collapseSignal,
  onToggleMark,
  onSetTags,
  onTagClick,
  onEditTags,
  onRequestDeleteHost,
  onRequestDeleteDrive,
}: {
  manifest: ManifestView
  query: string
  marksByKey: Record<string, Set<string>>
  tagsByKey: Record<string, Record<string, string[]>>
  tagFilter: string | null
  sizeActive: boolean
  collapseSignal: number
  onToggleMark: (key: string, path: string) => void
  onSetTags: (key: string, path: string, tags: string[]) => void
  onTagClick: (tag: string) => void
  onEditTags: (key: string, path: string, current: string[]) => void
  onRequestDeleteHost: () => void
  onRequestDeleteDrive: (drive: FolderNodeView) => void
}) {
  const genText = formatGeneratedAt(manifest.generatedAt)
  const stats = hostStats(manifest.root)
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <Server className="w-4 h-4 text-white/50 shrink-0" />
        <span className="text-white/90 font-medium truncate">{manifest.root.name}</span>
        {manifest.root.name !== manifest.source && (
          <span className="text-white/35 text-xs shrink-0">· {manifest.source}</span>
        )}
        <button
          type="button"
          onClick={onRequestDeleteHost}
          title="删除该主机的索引与全部卷分片（经同步组删除并同步到其它后端）"
          className="ml-auto shrink-0 text-white/30 hover:text-red-300 px-1 leading-none"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="text-white/40 text-xs flex items-center gap-3 flex-wrap">
        <span>{manifest.folderCount} 个文件夹</span>
        {stats.has && (
          <span className="text-sky-200/60">
            {formatCount(stats.files)} 个文件 · {formatSize(stats.bytes)}
            {stats.hasDisk && stats.disk !== stats.bytes && <> · 占 {formatSize(stats.disk)}</>}
          </span>
        )}
        {genText && <span>生成于 {genText}</span>}
        {manifest.warnings.length > 0 && (
          <span className="text-amber-300/70 flex items-center gap-1">
            <FileWarning className="w-3 h-3" />
            {manifest.warnings.length} 条告警
          </span>
        )}
      </div>

      <div className="pt-1 -mx-1">
        {manifest.root.children.length === 0 ? (
          <div className="text-white/30 text-xs px-1">（无子目录）</div>
        ) : (
          manifest.root.children
            .filter((c): c is FolderNodeView => c.type === 'folder')
            .map((child, i) => {
              // 每块盘的稳定身份命名空间：有 volumeId 用 volumeId（跨主机去重），否则回退 主机::盘符。
              const key = child.volumeId || `${manifest.source}::${child.name}`
              return (
                <FolderTree
                  key={`${child.name}-${i}`}
                  node={child}
                  depth={0}
                  forceExpand={!!query || !!tagFilter || sizeActive}
                  collapseSignal={collapseSignal}
                  basePath={[child.name]}
                  markKey={key}
                  marked={marksByKey[key] || EMPTY_SET}
                  userTags={tagsByKey[key] || EMPTY_TAGS_MAP}
                  tagFilter={tagFilter}
                  onToggle={onToggleMark}
                  onSetTags={onSetTags}
                  onTagClick={onTagClick}
                  onEditTags={onEditTags}
                  onRequestDeleteDrive={onRequestDeleteDrive}
                  driveInfo={{
                    hostSource: manifest.source,
                    generatedAt: manifest.generatedAt,
                    warnings: manifest.warnings.length,
                  }}
                />
              )
            })
        )}
      </div>
    </div>
  )
}

// 递归统计某节点下的文件夹数量（不含自身），用于悬浮卡片展示磁盘规模。
function countDescendantFolders(node: FolderNodeView): number {
  let n = 0
  for (const c of node.children) {
    if (c.type === 'folder') n += 1 + countDescendantFolders(c)
  }
  return n
}

/**
 * 磁盘（驱动层节点）悬浮信息卡片：鼠标悬浮在盘符行上时，汇总该盘的
 * 卷身份、挂载主机、统计、分片来源、标签与清单元信息。仅 depth=0 的盘符行渲染。
 * 纯展示、pointer-events-none，不拦截下方目录行的点击。
 */
function DriveTooltip({
  node,
  hostSource,
  generatedAt,
  tags,
  markedCount,
  warnings,
}: {
  node: FolderNodeView
  hostSource: string
  generatedAt: string | null
  tags: string[]
  markedCount: number
  warnings: number
}) {
  const rows: Array<[string, string]> = []
  rows.push(['挂载主机', hostSource])
  rows.push([
    '卷标识',
    node.volumeId ?? '未写入 .dir-struct-id（按 主机::盘符 去重）',
  ])
  // 磁盘 SN：清单本身不记录物理盘序列号，卷 ID 是 openlist 按盘序号拼出来的
  // （openlist-<SN>-<单个数字>）时按同一规则现算，规则与 zip-browser 侧一致。
  const serialInfo = volumeSerialInfo(node.volumeId)
  if (serialInfo.serial) {
    rows.push([
      '磁盘 SN',
      serialInfo.source === 'derived'
        ? `${serialInfo.serial}（按卷 ID 推断）`
        : serialInfo.serial,
    ])
  }
  rows.push(['子目录', `${formatCount(countDescendantFolders(node))} 个（递归）`])
  if (node.fileCount !== undefined) rows.push(['文件数', `${formatCount(node.fileCount)} 个`])
  if (node.totalSize !== undefined) rows.push(['逻辑大小', formatSize(node.totalSize)])
  // 占用与逻辑大小相同时不重复展示（Windows 下常按逻辑大小替代）。
  if (node.totalSizeOnDisk !== undefined && node.totalSizeOnDisk !== node.totalSize) {
    rows.push(['占用空间', formatSize(node.totalSizeOnDisk)])
  }
  if (node.sizePartial) {
    rows.push(['统计完整性', '下界：子树有部分无法读取，实际值 ≥ 以上数值'])
  }
  const mtime = formatMtime(node.mtime)
  if (mtime) rows.push(['目录修改时间', mtime])
  if (node.sources && node.sources.length > 1) {
    rows.push(['分片来源', `${node.sources.length} 台：${node.sources.join('、')}`])
  }
  const allTags = [...new Set([...node.tags, ...tags])]
  if (allTags.length) rows.push(['标签', allTags.join('、')])
  if (markedCount > 0) rows.push(['待深挖标记', `${markedCount} 个目录`])
  const gen = formatGeneratedAt(generatedAt)
  if (gen) rows.push(['清单生成于', gen])
  if (warnings > 0) rows.push(['解析告警', `${warnings} 条`])

  return (
    <div className="pointer-events-none absolute left-8 top-full z-30 mt-1 hidden w-80 rounded-lg border border-white/15 bg-slate-900/95 p-3 text-xs shadow-xl backdrop-blur-sm group-hover:block">
      <div className="mb-2 flex items-center gap-2 border-b border-white/10 pb-2">
        <HardDrive className="w-4 h-4 text-sky-300/80" />
        <span className="font-medium text-white/90">磁盘 {node.name}</span>
        <span className="ml-auto text-white/35">卷信息</span>
      </div>
      <div className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <span className="w-20 shrink-0 text-white/40">{label}</span>
            <span className="min-w-0 flex-1 break-all text-white/80">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FolderTree({
  node,
  depth,
  forceExpand,
  collapseSignal,
  basePath,
  markKey,
  marked,
  userTags,
  tagFilter,
  onToggle,
  onSetTags,
  onTagClick,
  onEditTags,
  onRequestDeleteDrive,
  driveInfo,
}: {
  node: FsNodeView
  depth: number
  forceExpand: boolean
  collapseSignal: number
  basePath: string[]
  markKey: string
  marked: Set<string>
  userTags: Record<string, string[]>
  tagFilter: string | null
  onToggle: (key: string, path: string) => void
  onSetTags: (key: string, path: string, tags: string[]) => void
  onTagClick: (tag: string) => void
  onEditTags: (key: string, path: string, current: string[]) => void
  onRequestDeleteDrive?: (drive: FolderNodeView) => void
  // 仅磁盘行（depth=0）传入；普通目录递归时不传，因而不显示悬浮卡片。
  driveInfo?: { hostSource: string; generatedAt: string | null; warnings: number }
}) {
  // 默认展开顶层（盘符/根目录），深层收起；筛选命中时整棵匹配树强制展开。
  const [open, setOpen] = useState(depth === 0 && !forceExpand)
  // 「全部收起」信号：自增后所有节点收回顶层；筛选强制展开除外。
  useEffect(() => {
    if (!forceExpand) setOpen(false)
  }, [collapseSignal, forceExpand])
  const expanded = forceExpand || open
  const isFolder = node.type === 'folder'
  const hasChildren = isFolder && node.children.length > 0
  const indent = { paddingLeft: `${depth * 14 + 8}px` }
  // host-relative 路径（盘符 + 嵌套名称，用 / 连接），用于深挖标记与用户标签。
  const path = basePath.join('/')
  const isMarked = isFolder && marked.has(path)
  const tags = userTags[path] || []

  // 打开标签编辑弹窗（替换原 window.prompt），由顶层 TagEditorModal 接管编辑与保存。
  const editTags = () => {
    onEditTags(markKey, path, tags)
  }

  return (
    <div>
      <div
        className="group relative flex items-center gap-1 py-1 pr-2 rounded hover:bg-white/5"
        style={indent}
      >
        {hasChildren ? (
          <button
            onClick={() => {
              if (!forceExpand) setOpen((v) => !v)
            }}
            className={`shrink-0 ${forceExpand ? 'text-white/30' : 'text-white/45 hover:text-white'}`}
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {node.type === 'file' ? (
          <File className="w-4 h-4 text-white/45 shrink-0" />
        ) : expanded && hasChildren ? (
          <FolderOpen className="w-4 h-4 text-sky-300/70 shrink-0" />
        ) : (
          <Folder className="w-4 h-4 text-sky-300/70 shrink-0" />
        )}
        <span className="text-white/75 text-sm truncate">{node.name}</span>
        {node.tags.length > 0 && (
          <span className="flex items-center gap-1 flex-wrap ml-1">
            {node.tags.map((t, i) => (
              <TagChip
                key={`${t}-${i}`}
                tag={t}
                active={tagFilter === t}
                onClick={() => onTagClick(t)}
              />
            ))}
          </span>
        )}
        {tags.length > 0 && (
          <span className="flex items-center gap-1 flex-wrap ml-1">
            {tags.map((t, i) => (
              <UserTagChip
                key={`${t}-${i}`}
                tag={t}
                active={tagFilter === t}
                onClick={() => onTagClick(t)}
              />
            ))}
          </span>
        )}
        {node.type === 'folder' ? <FolderSize node={node} /> : <FileSize node={node} />}
        {formatMtime(node.mtime) && (
          <span
            className="shrink-0 text-white/30 text-[11px] font-mono tabular-nums leading-none whitespace-nowrap"
            title={`最后修改 ${formatMtime(node.mtime)}`}
          >
            改 {formatMtime(node.mtime)}
          </span>
        )}
        {node.type === 'folder' && node.sources && node.sources.length > 1 && (
          <span
            className="ml-1 shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-200/80 font-mono leading-none"
            title={`该盘由以下主机的分片合并而来：${node.sources.join('、')}`}
          >
            ⇄ {node.sources.length} 台
          </span>
        )}
        {isMarked && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/20 text-sky-200/90 font-mono leading-none shrink-0">
            ↳ 待深挖
          </span>
        )}
        <span className="ml-auto shrink-0 flex items-center gap-1">
          {node.type === 'folder' && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation()
                onToggle(markKey, path)
              }}
              title="继续解析下一层（标记后需在本机重新运行 dir-struct-gen 生成清单）"
              className="shrink-0 opacity-0 group-hover:opacity-100 text-sky-300/70 hover:text-sky-200 text-xs px-1 leading-none"
            >
              ↳
            </button>
          )}
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              editTags()
            }}
            title={tags.length ? `编辑标签（当前：${tags.join('、')}）` : '给该条目打标签'}
            className="shrink-0 text-white/30 hover:text-amber-200 px-1 leading-none"
          >
            <Tag className="w-3.5 h-3.5" />
          </button>
          {depth === 0 && node.type === 'folder' && node.shardBases && node.shardBases.length > 0 && onRequestDeleteDrive && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation()
                onRequestDeleteDrive(node)
              }}
              title="删除该盘符的清单分片（经同步组删除并同步到其它后端）"
              className="shrink-0 opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-300 px-1 leading-none"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
        {driveInfo && node.type === 'folder' && (
          <DriveTooltip
            node={node}
            hostSource={driveInfo.hostSource}
            generatedAt={driveInfo.generatedAt}
            tags={tags}
            markedCount={marked.size}
            warnings={driveInfo.warnings}
          />
        )}
      </div>

      {expanded && node.type === 'folder' && node.children.length > 0 && (
        <div>
          {node.children.map((c, i) => (
            <FolderTree
              key={`${c.name}-${i}`}
              node={c}
              depth={depth + 1}
              forceExpand={forceExpand}
              collapseSignal={collapseSignal}
              basePath={[...basePath, c.name]}
              markKey={markKey}
              marked={marked}
              userTags={userTags}
              tagFilter={tagFilter}
              onToggle={onToggle}
              onSetTags={onSetTags}
              onTagClick={onTagClick}
              onEditTags={onEditTags}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 删除确认弹窗：列出将删除的清单文件，确认后走数据组 deleteFile（墓碑 + 自动同步）。 */
function DeleteConfirmModal({
  confirm,
  deleting,
  onCancel,
  onConfirm,
}: {
  confirm: {
    kind: 'host' | 'drive'
    title: string
    files: string[]
  } | null
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!confirm) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-zinc-900 border border-white/10 p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-red-200">
          <AlertTriangle className="w-4 h-4" />
          <span className="font-medium">{confirm.title}</span>
        </div>
        <div className="text-white/55 text-xs leading-relaxed">
          删除经数据同步组写入墓碑，会自动同步到已配置的远端后端；该主机/盘符下次重新扫描生成清单后才会再次出现。
        </div>
        <div className="max-h-40 overflow-auto rounded-lg bg-white/5 p-2">
          {confirm.files.length === 0 ? (
            <div className="text-white/35 text-xs">（无可删除的清单文件）</div>
          ) : (
            <ul className="text-xs font-mono text-white/65 space-y-1">
              {confirm.files.map((f) => (
                <li key={f}>struct/{f}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/70 hover:bg-white/15 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting || confirm.files.length === 0}
            className="px-3 py-1.5 rounded-lg text-xs bg-red-500/80 hover:bg-red-500 text-white disabled:opacity-50"
          >
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
