// 文件浏览器应用 UI 层。
// 状态机：loading / error（含「去连接」引导）/ empty / data。
// 手动刷新（与设备监控一致，无自动刷新）；多主机并列展示各自的只读目录树；
// 关键词筛选文件夹（命中节点 + 祖先链），命中时整棵匹配树自动展开；文件夹标签小徽标。

import { useCallback, useEffect, useMemo, useState } from 'react'
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
} from 'lucide-react'
import { fetchDirStructManifests, RsNotConnectedError, RsAuthError } from './filebrowser/fetch'
import { filterTree, normalizeManifests } from './filebrowser/normalize'
import type { FolderNodeView, ManifestView } from './filebrowser/types'

type LoadState = 'loading' | 'error' | 'empty' | 'data'

export default function FileBrowserApp() {
  const [state, setState] = useState<LoadState>('loading')
  const [manifests, setManifests] = useState<ManifestView[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    setErrorMsg('')
    setErrorCode('')
    try {
      const raws = await fetchDirStructManifests()
      const ms = normalizeManifests(raws)
      setManifests(ms)
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

  useEffect(() => {
    void load()
  }, [load])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return manifests
    return manifests
      .map((m) => {
        const root = filterTree(m.root, q)
        return root ? { ...m, root } : null
      })
      .filter((m): m is ManifestView => m !== null)
  }, [manifests, q])

  const totalFolders = useMemo(
    () => manifests.reduce((s, m) => s + m.folderCount, 0),
    [manifests],
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-white/90 font-medium flex items-center gap-2">
          <FolderTreeIcon className="w-4 h-4 text-white/50" />
          文件浏览器
        </h1>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/70 hover:bg-white/15 hover:text-white flex items-center gap-1.5 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          刷新
        </button>
      </div>

      {state === 'data' && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-white/45 text-xs">{manifests.length} 台主机</span>
          <span className="text-white/45 text-xs">{totalFolders} 个文件夹</span>
          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 text-white/35 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选文件夹…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/85 text-sm placeholder:text-white/30 outline-none focus:border-white/25"
            />
          </div>
        </div>
      )}

      {state === 'loading' && <LoadingState />}
      {state === 'error' && <ErrorState code={errorCode} message={errorMsg} onRetry={load} />}
      {state === 'empty' && <EmptyState onRetry={load} />}
      {state === 'data' &&
        (filtered.length === 0 ? (
          <div className="text-white/30 text-sm text-center py-8">
            {q ? '无匹配的文件夹' : 'app_data/folders 下暂无目录结构清单'}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((m) => (
              <HostCard key={m.source} manifest={m} query={q} />
            ))}
          </div>
        ))}
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
      <div className="text-white/70">app_data/folders 下暂无目录结构清单</div>
      <div className="text-white/40 text-xs">
        确认 dir-struct-gen 已向 RemoteStorage 写入主机目录清单（每台主机一个 .json）后重试。
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
  // 已连接、但当前令牌缺 app_data 作用域（服务端 401）——需断开重连换取新令牌。
  if (code === 'AUTH') {
    return (
      <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 p-6 text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-amber-300/80 mx-auto" />
        <div className="text-amber-100">目录权限不足</div>
        <div className="text-white/55 text-sm leading-relaxed">
          已连接 RemoteStorage，但当前令牌缺少 <span className="font-mono text-amber-200">app_data</span> 目录的读权限，
          因此无法读取目录结构清单（服务端返回 401）。
        </div>
        <div className="text-white/45 text-xs leading-relaxed text-left mx-auto max-w-sm">
          解决：在 OneNav 主页「断开 RemoteStorage」，再用同一账号（user@host）重新连接一次——
          OAuth 会请求新的权限范围，新令牌即可读取 app_data。重新连接后点「刷新」。
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={() => {
              window.location.href = '../../index.html'
            }}
            className="px-4 py-2 rounded-lg bg-sky-500/80 hover:bg-sky-500 text-white text-sm"
          >
            去主页重新连接
          </button>
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
        <div className="text-white/80">未连接远程存储</div>
        <div className="text-white/45 text-sm">无法读取目录结构清单。请在主页完成 RemoteStorage 连接后重试。</div>
        <div className="flex justify-center gap-2">
          <button
            onClick={() => {
              window.location.href = '../../index.html'
            }}
            className="px-4 py-2 rounded-lg bg-sky-500/80 hover:bg-sky-500 text-white text-sm"
          >
            去连接
          </button>
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

function TagChip({ tag }: { tag: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/15 text-indigo-200/90 font-mono leading-none">
      {tag}
    </span>
  )
}

function HostCard({ manifest, query }: { manifest: ManifestView; query: string }) {
  const genText = formatGeneratedAt(manifest.generatedAt)
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <Server className="w-4 h-4 text-white/50 shrink-0" />
        <span className="text-white/90 font-medium truncate">{manifest.root.name}</span>
        {manifest.root.name !== manifest.source && (
          <span className="text-white/35 text-xs shrink-0">· {manifest.source}</span>
        )}
      </div>
      <div className="text-white/40 text-xs flex items-center gap-3 flex-wrap">
        <span>{manifest.folderCount} 个文件夹</span>
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
          manifest.root.children.map((child, i) => (
            <FolderTree key={`${child.name}-${i}`} node={child} depth={0} forceExpand={!!query} />
          ))
        )}
      </div>
    </div>
  )
}

function FolderTree({
  node,
  depth,
  forceExpand,
}: {
  node: FolderNodeView
  depth: number
  forceExpand: boolean
}) {
  // 默认展开顶层（盘符/根目录），深层收起；筛选命中时整棵匹配树强制展开。
  const [open, setOpen] = useState(depth === 0 && !forceExpand)
  const expanded = forceExpand || open
  const hasChildren = node.children.length > 0
  const indent = { paddingLeft: `${depth * 14 + 8}px` }

  return (
    <div>
      <div
        className="flex items-center gap-1 py-1 pr-2 rounded hover:bg-white/5"
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
        {expanded && hasChildren ? (
          <FolderOpen className="w-4 h-4 text-sky-300/70 shrink-0" />
        ) : (
          <Folder className="w-4 h-4 text-sky-300/70 shrink-0" />
        )}
        <span className="text-white/75 text-sm truncate">{node.name}</span>
        {node.tags.length > 0 && (
          <span className="flex items-center gap-1 flex-wrap ml-1">
            {node.tags.map((t, i) => (
              <TagChip key={`${t}-${i}`} tag={t} />
            ))}
          </span>
        )}
      </div>

      {expanded && hasChildren && (
        <div>
          {node.children.map((c, i) => (
            <FolderTree key={`${c.name}-${i}`} node={c} depth={depth + 1} forceExpand={forceExpand} />
          ))}
        </div>
      )}
    </div>
  )
}
