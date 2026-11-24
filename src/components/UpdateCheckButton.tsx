import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react'
import { applyUpdate, checkForUpdate, type UpdateCheckResult } from '@/lib/update-check'

type Phase = 'idle' | 'checking' | 'available' | 'latest' | 'unknown' | 'applying'

/**
 * 「强制检查更新」按钮：主页与所有独立应用页共用。
 *
 * 不依赖 sw.js 的自动检查——点击即主动拉取远端 `version.json` 比对，
 * 同时探测 SW 是否已有 waiting Worker；sw.js 异常/未注册时版本清单通道仍能发现更新。
 * 发现新版本后点「立即更新」：有 waiting Worker 走 SKIP_WAITING，没有则注销 SW + 清缓存后重载。
 */
export default function UpdateCheckButton({ className = '' }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [detail, setDetail] = useState('')
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  const scheduleHide = (ms: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setPhase((p) => (p === 'checking' || p === 'applying' ? p : 'idle'))
    }, ms)
  }

  const runCheck = async () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setPhase('checking')
    setDetail('')
    try {
      const r = await checkForUpdate()
      setResult(r)
      if (r.status === 'update-available') {
        setPhase('available')
      } else if (r.status === 'up-to-date') {
        setPhase('latest')
        scheduleHide(4000)
      } else {
        setPhase('unknown')
        setDetail(r.message)
        scheduleHide(8000)
      }
    } catch (err) {
      setPhase('unknown')
      setDetail(err instanceof Error ? err.message : String(err))
      scheduleHide(8000)
    }
  }

  const handleClick = () => {
    if (phase === 'checking' || phase === 'applying') return
    if (phase === 'available') {
      void doApply()
      return
    }
    void runCheck()
  }

  const doApply = async () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setPhase('applying')
    setDetail('正在应用更新…')
    try {
      await applyUpdate()
      // applyUpdate 内部会重载页面；若没重载成功，这里补一次兜底
      setDetail('更新完成，正在刷新…')
    } catch (err) {
      setPhase('unknown')
      setDetail(`应用更新失败：${err instanceof Error ? err.message : String(err)}`)
      scheduleHide(10000)
    }
  }

  const open = phase !== 'idle' && phase !== 'checking'
  const spin = phase === 'checking' || phase === 'applying'

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={handleClick}
        disabled={spin}
        className="relative w-9 h-9 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition-all disabled:opacity-60"
        title="强制检查页面更新（不依赖后台 sw.js）"
        aria-label="强制检查页面更新"
      >
        <RefreshCw className={`w-4 h-4 ${spin ? 'animate-spin' : ''}`} />
        {phase === 'available' && (
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-[80] w-72 rounded-xl border border-white/15 bg-gray-900/95 backdrop-blur-xl px-3 py-2.5 text-xs text-white/80 shadow-xl">
          <div className="flex items-start gap-2">
            {phase === 'available' && <RefreshCw className="w-4 h-4 shrink-0 text-emerald-300 mt-0.5" />}
            {phase === 'latest' && <Check className="w-4 h-4 shrink-0 text-emerald-300 mt-0.5" />}
            {(phase === 'unknown' || phase === 'applying') && (
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-300 mt-0.5" />
            )}
            <div className="flex-1 leading-relaxed break-all">
              {phase === 'available' && (result?.message || '发现新版本')}
              {phase === 'latest' && (result?.message || '已是最新版本')}
              {phase === 'unknown' && (detail || '无法确认是否有更新')}
              {phase === 'applying' && (detail || '正在应用更新…')}
              {(phase === 'available' || phase === 'latest') && result && (
                <div className="mt-1 text-[11px] text-white/40">
                  本机 {result.local.sha || '?'} · {result.local.buildTime || '未知时间'}
                  {result.remote && phase === 'available' ? ` → 远端 ${result.remote.sha || '?'}` : ''}
                </div>
              )}
            </div>
            {phase !== 'applying' && (
              <button
                onClick={() => {
                  if (hideTimer.current) clearTimeout(hideTimer.current)
                  setPhase('idle')
                }}
                className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10"
                title="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {phase === 'available' && (
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => {
                  if (hideTimer.current) clearTimeout(hideTimer.current)
                  setPhase('idle')
                }}
                className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-white/70 hover:bg-white/10"
              >
                稍后
              </button>
              <button
                onClick={() => void doApply()}
                className="rounded-lg border border-emerald-300/30 bg-emerald-400/20 px-2.5 py-1.5 text-emerald-100 hover:bg-emerald-400/30"
              >
                立即更新
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
