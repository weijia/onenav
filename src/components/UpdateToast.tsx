import { useState, useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'

export default function UpdateToast() {
  const [show, setShow] = useState(false)
  const updateAvailableRef = useRef(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const handleUpdate = (reg: ServiceWorkerRegistration) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing
        if (!newWorker) return

        newWorker.addEventListener('statechange', () => {
          // 新 Worker 已安装且等待中，只通知一次
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            if (!updateAvailableRef.current) {
              updateAvailableRef.current = true
              console.log('[PWA] 新版本可用')
              setShow(true)
            }
          }
        })
      })
    }

    const checkUpdate = async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        if (!reg || !reg.active) {
          console.log('[PWA] Service Worker 未激活，跳过更新检查')
          return
        }
        handleUpdate(reg)

        // 页面加载后 3 秒检查更新
        setTimeout(() => {
          reg.update().catch((err: Error) => {
            if (err?.message?.includes('Failed to update')) {
              console.log('[PWA] 更新检查被跳过:', err.message)
            } else {
              console.error('[PWA] 检查更新失败:', err)
            }
          })
        }, 3000)
      } catch (err) {
        console.log('[PWA] Service Worker 未就绪，跳过更新检查:', err)
      }
    }

    checkUpdate()

    // 每 5 分钟检查一次更新
    const interval = setInterval(() => {
      navigator.serviceWorker.ready
        .then((reg) => {
          if (reg?.active) return reg.update()
        })
        .catch((err: Error) => {
          if (err?.message?.includes('Failed to update')) {
            console.log('[PWA] 更新检查被跳过:', err.message)
          } else {
            console.error('[PWA] 检查更新失败:', err)
          }
        })
    }, 5 * 60 * 1000)

    return () => {
      clearInterval(interval)
    }
  }, [])

  const handleRefresh = async () => {
    if (!('serviceWorker' in navigator)) return

    const reg = await navigator.serviceWorker.ready
    const newWorker = reg.waiting

    if (newWorker) {
      newWorker.postMessage({ type: 'SKIP_WAITING' })

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload()
      })
    }

    setShow(false)
  }

  if (!show) return null

  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[60] animate-slide-in-bottom">
      <div className="flex items-center gap-3 bg-gray-900/95 backdrop-blur-xl text-white px-4 py-3 rounded-xl border border-white/10 shadow-lg">
        <span className="text-sm">新版本可用</span>
        <button
          onClick={handleRefresh}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-sm transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          点击刷新
        </button>
      </div>
    </div>
  )
}
