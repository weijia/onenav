/**
 * Service Worker 注册模块
 *
 * 关键：使用 updateViaCache: 'none' 确保浏览器在检查 SW 更新时
 * 绕过 HTTP 缓存，始终从服务器获取最新的 sw.js。
 *
 * GitHub Pages 默认缓存 10 分钟，如果不设置 updateViaCache: 'none'，
 * 浏览器会使用缓存的 sw.js，导致永远检测不到更新（updatefound 不触发），
 * Chrome DevTools 中 "Received" 时间也可能显示为 1970-01-01（epoch 0）。
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', {
        scope: './',
        updateViaCache: 'none',
      })
      .catch((err) => {
        console.error('[PWA] Service Worker 注册失败:', err)
      })
  })
}
