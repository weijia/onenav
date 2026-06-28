import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'

export default function UpdateToast() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const handleUpdate = (reg: ServiceWorkerRegistration) => {
      // 监听新的 Service Worker 安装
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing
        if (!newWorker) return

        newWorker.addEventListener('statechange', () => {
          // 新 Worker 已安装且等待中，提示用户刷新
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('[PWA] 新版本可用')
            setShow(true)
          }
        })
      })
    }

    // 获取 Service Worker 注册并监听更新
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
          reg.update().catch((err) => {
            // 忽略 "Failed to update" 错误（开发环境或 scope 不匹配时常见）
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
        .catch((err) => {
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
      // 发送消息让新 Worker 跳过等待
      newWorker.postMessage({ type: 'SKIP_WAITING' })

      // 监听 controllerchange 事件，新 Worker 激活后刷新页面
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload()
      })
    }

    setShow(false)
  }

  if (!show) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 animate-slide-in">
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
