import { useEffect, useRef, useState } from 'react'
import { getSyncStatus, subscribeSyncStatus, type SyncStatusState } from '@/lib/sync-status'

/**
 * 同步状态胶囊（固定在页面底部中央，对齐主页「浮动同步状态」风格，并带进度细节）。
 * 数据来自全局同步状态 store（syncToRemoteStorage 写入）：
 *   - syncing：蓝底 + 呼吸动画，显示「同步中 · 读取 X/Y 文件」与细进度条 + 百分比
 *   - synced：绿底「已同步」，3 秒后自动消失
 *   - error：红底「同步失败」，6 秒后自动消失
 *   - idle：不渲染
 */
export default function SyncStatusChip() {
  const [st, setSt] = useState<SyncStatusState>(getSyncStatus())
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 订阅全局同步状态；取消订阅时清理。
  useEffect(() => {
    return subscribeSyncStatus(setSt)
  }, [])

  // synced / error 为瞬时态，自动消失，避免常驻遮挡。
  useEffect(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (st.status === 'synced' || st.status === 'error') {
      hideTimer.current = setTimeout(() => {
        setSt((prev) => (prev.status === st.status ? { ...prev, status: 'idle' } : prev))
      }, st.status === 'synced' ? 3000 : 6000)
    }
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [st.status])

  if (st.status === 'idle') return null

  const label =
    st.status === 'syncing'
      ? st.message || '同步中…'
      : st.status === 'synced'
        ? '已同步'
        : '同步失败'

  const cls =
    st.status === 'syncing'
      ? 'bg-blue-400/15 text-blue-100 border-blue-300/20 animate-pulse'
      : st.status === 'synced'
        ? 'bg-emerald-400/15 text-emerald-100 border-emerald-300/20'
        : 'bg-red-400/15 text-red-100 border-red-300/20'

  const pct = st.ratio != null ? Math.min(100, Math.round(st.ratio * 100)) : null

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] transition-all duration-300">
      <div className={`rounded-full border px-3 py-1.5 text-xs backdrop-blur-sm shadow-lg ${cls}`}>
        <div className="flex items-center gap-2 whitespace-nowrap">
          {st.status === 'syncing' && (
            <span className="inline-block h-2 w-2 rounded-full bg-blue-300 animate-pulse" />
          )}
          <span>{label}</span>
          {pct != null && st.status === 'syncing' && <span className="opacity-70">{pct}%</span>}
        </div>
        {st.status === 'syncing' && (
          <div className="mt-1 h-1 w-40 max-w-[60vw] overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-blue-300 transition-all duration-200"
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
