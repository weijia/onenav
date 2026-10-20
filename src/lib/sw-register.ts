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
/**
 * Service Worker 注册模块
 *
 * 关键：使用 updateViaCache: 'none' 确保浏览器在检查 SW 更新时
 * 绕过 HTTP 缓存，始终从服务器获取最新的 sw.js。
 *
 * GitHub Pages 默认缓存 10 分钟，如果不设置 updateViaCache: 'none'，
 * 浏览器会使用缓存的 sw.js，导致永远检测不到更新（updatefound 不触发），
 * Chrome DevTools 中 "Received" 时间也可能显示为 1970-01-01（epoch 0）。
 *
 * @param swPath 相对「调用页面文档」的 SW 脚本路径。
 *   - 主页面（根目录 index.html）用默认 './sw.js'。
 *   - 独立应用页位于 apps/<id>/index.html，需传 '../../sw.js' 指向根目录 SW，
 *     从而让应用页也能离线 & 检测全站更新（与主页面共用同一份 SW）。
 */
export function registerServiceWorker(swPath = './sw.js') {
  if (!('serviceWorker' in navigator)) return

  const doRegister = () => {
    navigator.serviceWorker
      .register(swPath, {
        scope: './',
        updateViaCache: 'none',
      })
      .catch((err) => {
        console.error('[PWA] Service Worker 注册失败:', err)
      })
  }

  // 兼容两种调用时机：
  // 1) 模块顶层尽早注册（主页面 main.tsx）——load 尚未触发，走 else 分支；
  // 2) React 挂载后注册（应用页 AppHost）——load 可能已触发，
  //    若直接 addEventListener('load') 监听器永不执行，故 readyState 已 complete 时立即注册。
  if (document.readyState === 'complete') {
    doRegister()
  } else {
    window.addEventListener('load', doRegister, { once: true })
  }
}
