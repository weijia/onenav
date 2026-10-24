// 设备监控应用 UI 层。
// 状态机：loading / error（含「去连接」引导）/ empty / data。
// 手动刷新（Q6：无自动刷新）；在线徽标；磁盘子卡片 + 分区映射；敏感字段密码遮罩 + 点击揭示（Q8）。

import { useCallback, useEffect, useState } from 'react'
import {
  Server,
  RefreshCw,
  Wifi,
  WifiOff,
  Eye,
  EyeOff,
  AlertTriangle,
  Plug,
  HardDrive,
  Cpu,
  ShieldAlert,
} from 'lucide-react'
import { fetchUfsNodesRaw, RsNotConnectedError, RsAuthError } from './hostmonitor/fetch'
import { reauthorizeForUfsNodes } from '@/lib/remotestorage-connection'
import { normalizeUfsNodes } from './hostmonitor/normalize'
import type { ControlNodeView, DiskView, HostView, LogicalDiskView, SensitiveField } from './hostmonitor/types'

type LoadState = 'loading' | 'error' | 'empty' | 'data'

export default function HostDiskApp() {
  const [state, setState] = useState<LoadState>('loading')
  const [hosts, setHosts] = useState<HostView[]>([])
  const [controlNodes, setControlNodes] = useState<ControlNodeView[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [errorCode, setErrorCode] = useState('')

  const load = useCallback(async () => {
    setState('loading')
    setErrorMsg('')
    setErrorCode('')
    try {
      const raws = await fetchUfsNodesRaw()
      const { hosts: hs, controlNodes: cns } = normalizeUfsNodes(raws)
      setHosts(hs)
      setControlNodes(cns)
      setState(hs.length > 0 || cns.length > 0 ? 'data' : 'empty')
    } catch (e) {
      if (e instanceof RsAuthError) {
        // 一次性自动重授权：仅对「已连接但缺 ufs-nodes 作用域」的 401 触发，防止死循环。
        // 若服务商未真正升级 scope 而再次 401，flag 已置位 → 退回手动「目录权限不足」面板。
        const REAUTH_FLAG = 'onenav:rs-ufs-reauth-attempted'
        if (!sessionStorage.getItem(REAUTH_FLAG)) {
          sessionStorage.setItem(REAUTH_FLAG, '1')
          if (reauthorizeForUfsNodes()) {
            // 已发起完整 OAuth 跳转，页面即将离开，不再设置错误态。
            return
          }
        }
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

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-white/90 font-medium flex items-center gap-2">
          <Cpu className="w-4 h-4 text-white/50" />
          设备监控
        </h1>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/70 hover:bg-white/15 hover:text-white flex items-center gap-1.5 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          刷新
        </button>
      </div>

      {state === 'loading' && <LoadingState />}
      {state === 'error' && <ErrorState code={errorCode} message={errorMsg} onRetry={load} />}
      {state === 'empty' && <EmptyState onRetry={load} />}
      {state === 'data' && (
        <div className="space-y-5">
          <div className="space-y-3">
            {hosts.map((h) => (
              <HostCard key={h.uuid} host={h} />
            ))}
          </div>
          {controlNodes.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-white/40 text-xs px-1">
                <ShieldAlert className="w-3.5 h-3.5" />
                控制节点（敏感凭证已遮罩，点击揭示）
              </div>
              {controlNodes.map((n) => (
                <ControlNodeCard key={n.uuid} node={n} />
              ))}
            </div>
          )}
        </div>
      )}
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
      <Server className="w-8 h-8 text-white/40 mx-auto" />
      <div className="text-white/70">ufs-nodes 下暂无主机 / 磁盘数据</div>
      <div className="text-white/40 text-xs">确认 home_cloud 已向 RemoteStorage 写入主机心跳或磁盘 SMART 后重试。</div>
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
  // 已连接、但当前令牌缺 ufs-nodes 作用域（服务端 401）——需断开重连换取新令牌。
  if (code === 'AUTH') {
    return (
      <div className="rounded-xl bg-amber-500/10 border border-amber-400/30 p-6 text-center space-y-3">
        <ShieldAlert className="w-8 h-8 text-amber-300/80 mx-auto" />
        <div className="text-amber-100">目录权限不足</div>
        <div className="text-white/55 text-sm leading-relaxed">
          已连接 RemoteStorage，但当前令牌缺少 <span className="font-mono text-amber-200">ufs-nodes</span> 目录的读权限，
          因此无法读取主机 / 磁盘数据（服务端返回 401）。
        </div>
        <div className="text-white/45 text-xs leading-relaxed text-left mx-auto max-w-sm">
          解决：在 OneNav 主页「断开 RemoteStorage」，再用同一账号（user@host）重新连接一次——
          OAuth 会请求新的权限范围，新令牌即可读取 ufs-nodes。重新连接后点「刷新」。
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
        <div className="text-white/45 text-sm">无法读取主机 / 磁盘数据。请在主页完成 RemoteStorage 连接后重试。</div>
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

function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${
        online ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/10 text-white/40'
      }`}
    >
      {online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {online ? '在线' : '离线'}
    </span>
  )
}

function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-1 min-w-0">
      <span className="text-white/30 shrink-0">{label}</span>
      <span className="text-white/60 truncate">{value ?? '—'}</span>
    </div>
  )
}

function SensitiveRow({ field }: { field: SensitiveField }) {
  const [revealed, setRevealed] = useState(false)
  const masked = '•'.repeat(Math.min(Math.max(field.value.length, 4), 16))
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-amber-200/80 w-20 shrink-0">{field.label}</span>
      <span className="text-amber-100 font-mono flex-1 truncate">{revealed ? field.value : masked}</span>
      <button
        onClick={() => setRevealed((v) => !v)}
        className="text-amber-200/70 hover:text-amber-100 shrink-0"
        title={revealed ? '隐藏' : '揭示'}
      >
        {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

function HealthBadge({ health, hasSmart }: { health: string | null; hasSmart: boolean }) {
  if (!hasSmart) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/40">无 SMART</span>
  }
  const ok = (health ?? '').toUpperCase() === 'PASSED'
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${
        ok ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'
      }`}
    >
      {health ?? '未知'}
    </span>
  )
}

function LogicalRow({ l }: { l: LogicalDiskView }) {
  const pct = l.usagePercent
  const barColor =
    pct == null
      ? 'bg-white/20'
      : pct >= 90
        ? 'bg-rose-500/70'
        : pct >= 70
          ? 'bg-amber-500/70'
          : 'bg-emerald-500/70'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-white/70 font-mono w-10 shrink-0">{l.deviceId}</span>
      <span className="text-white/45 truncate flex-1">
        {l.volumeName}
        {l.fileSystem ? ` · ${l.fileSystem}` : ''}
      </span>
      <div className="w-16 h-1.5 rounded bg-white/10 overflow-hidden shrink-0">
        <div className={barColor} style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, height: '100%' }} />
      </div>
      <span className="text-white/55 w-10 text-right shrink-0">{pct != null ? `${pct}%` : ''}</span>
    </div>
  )
}

function DiskCard({ disk }: { disk: DiskView }) {
  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <HardDrive className="w-3.5 h-3.5 text-white/40 shrink-0" />
          <span className="text-white/85 text-sm truncate">{disk.model ?? disk.serial}</span>
        </div>
        <HealthBadge health={disk.health} hasSmart={disk.hasSmart} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-white/45">
        <Info label="序列号" value={disk.serial} />
        <Info label="容量" value={disk.capacity} />
        <Info label="接口" value={disk.interfaceType} />
        <Info label="介质" value={disk.mediaType} />
        <Info label="温度" value={disk.temperature != null ? `${disk.temperature}℃` : null} />
        <Info label="分区数" value={disk.partitions != null ? String(disk.partitions) : null} />
      </div>

      {disk.logicalDisks.length > 0 && (
        <div className="space-y-1">
          <div className="text-white/40 text-[11px]">分区映射</div>
          {disk.logicalDisks.map((l) => (
            <LogicalRow key={l.deviceId} l={l} />
          ))}
        </div>
      )}
    </div>
  )
}

function HostCard({ host }: { host: HostView }) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-white/50 shrink-0" />
          <span className="text-white/90 font-medium truncate">{host.name ?? host.uuid}</span>
          <OnlineBadge online={host.online} />
        </div>
        <div className="text-white/40 text-xs mt-1 space-y-0.5">
          <div className="font-mono break-all">UUID: {host.uuid}</div>
          {host.localIp && <div>局域网 IP: {host.localIp}</div>}
          {(host.platform || host.hostname) && (
            <div>
              {host.platform}
              {host.platformVersion ? ` ${host.platformVersion}` : ''}
              {host.hostname ? ` · ${host.hostname}` : ''}
              {host.machine ? ` · ${host.machine}` : ''}
            </div>
          )}
          {host.lastAccessStr && <div>采集时间: {host.lastAccessStr}</div>}
        </div>
      </div>

      {host.sensitive.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-400/20 p-2 space-y-1">
          <div className="text-amber-200 text-xs flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> 敏感信息（点击揭示）
          </div>
          {host.sensitive.map((s) => (
            <SensitiveRow key={s.label} field={s} />
          ))}
        </div>
      )}

      {host.disks.length === 0 ? (
        <div className="text-white/30 text-xs">暂无磁盘数据</div>
      ) : (
        <div className="space-y-2">
          {host.disks.map((d) => (
            <DiskCard key={d.serial} disk={d} />
          ))}
        </div>
      )}
    </div>
  )
}

function ControlNodeCard({ node }: { node: ControlNodeView }) {
  return (
    <div className="rounded-xl bg-amber-500/[0.07] border border-amber-400/20 p-4 space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="w-4 h-4 text-amber-300/80 shrink-0" />
        <span className="text-amber-100/90 font-medium truncate">{node.name ?? node.uuid}</span>
        <OnlineBadge online={node.online} />
      </div>
      <div className="text-white/40 text-xs font-mono break-all">UUID: {node.uuid}</div>
      {node.sensitive.length > 0 ? (
        <div className="rounded-lg bg-amber-500/10 border border-amber-400/20 p-2 space-y-1">
          {node.sensitive.map((s) => (
            <SensitiveRow key={s.label} field={s} />
          ))}
        </div>
      ) : (
        <div className="text-white/30 text-xs">无敏感凭证</div>
      )}
    </div>
  )
}