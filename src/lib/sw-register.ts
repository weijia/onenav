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
 * @param swPath SW 脚本路径，默认 './sw.js'（主页面用法，行为与之前完全一致）。
 *               独立应用页位于 apps/<id>/index.html，需传 '../../sw.js' 指向根 SW。
 * @param scope  可选作用域。不传时浏览器默认以 sw.js 所在目录为作用域，
 *               独立应用页正是靠这一点把根 SW 注册为全站作用域（覆盖 /apps/**）。
 */
export function registerServiceWorker(swPath = './sw.js', scope?: string) {
  if (!('serviceWorker' in navigator)) return

  const doRegister = () => {
    const options: RegistrationOptions = { updateViaCache: 'none' }
    if (scope) options.scope = scope
    navigator.serviceWorker
      .register(swPath, options)
      .catch((err) => {
        console.error('[PWA] Service Worker 注册失败:', err)
      })
  }

  // React 挂载可能晚于 load 事件（此时再 addEventListener 永远不会触发），故需先判断 readyState
  if (document.readyState === 'complete') doRegister()
  else window.addEventListener('load', doRegister, { once: true })
}
