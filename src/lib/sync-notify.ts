/**
 * 同步进度提示（纯 DOM toast，无框架依赖）。
 *
 * 用法：
 *   const toast = showSyncToast('准备同步…')
 *   toast.update('已从服务器读取 3/10 个文件')
 *   toast.finish('同步完成')
 *   toast.error('同步失败：xxx')
 * 同一时刻只会显示一个同步 toast（自动复用/替换）。
 */

let container: HTMLElement | null = null
let currentToast: {
  el: HTMLElement
  bar: HTMLElement
  text: HTMLElement
  update: (msg: string, ratio?: number) => void
  finish: (msg: string) => void
  error: (msg: string) => void
  dismiss: () => void
} | null = null

function ensureContainer(): HTMLElement {
  if (container && document.body.contains(container)) return container
  container = document.createElement('div')
  container.id = 'onenav-sync-toast-container'
  container.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:2147483647',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'pointer-events:none',
  ].join(';')
  document.body.appendChild(container)
  return container
}

export interface SyncToast {
  update: (msg: string, ratio?: number) => void
  finish: (msg: string) => void
  error: (msg: string) => void
  dismiss: () => void
}

export function showSyncToast(initial: string): SyncToast {
  const root = ensureContainer()

  // 复用/替换当前 toast
  if (currentToast && document.body.contains(currentToast.el)) {
    currentToast.dismiss()
  }

  const el = document.createElement('div')
  el.style.cssText = [
    'min-width:240px',
    'max-width:320px',
    'background:rgba(33,37,41,0.95)',
    'color:#fff',
    'border-radius:8px',
    'padding:10px 12px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.3)',
    'font-size:13px',
    'line-height:1.5',
    'pointer-events:auto',
  ].join(';')

  const text = document.createElement('div')
  text.textContent = initial

  const barWrap = document.createElement('div')
  barWrap.style.cssText = 'height:4px;background:rgba(255,255,255,0.18);border-radius:2px;margin-top:6px;overflow:hidden;'
  const bar = document.createElement('div')
  bar.style.cssText = 'height:100%;width:0%;background:#4dabf7;transition:width 0.2s ease;border-radius:2px;'
  barWrap.appendChild(bar)

  el.appendChild(text)
  el.appendChild(barWrap)
  root.appendChild(el)

  let dismissed = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const api: SyncToast = {
    update(msg: string, ratio?: number) {
      if (dismissed) return
      text.textContent = msg
      if (typeof ratio === 'number' && ratio >= 0) {
        bar.style.width = `${Math.min(100, Math.round(ratio * 100))}%`
      }
    },
    finish(msg: string) {
      if (dismissed) return
      text.textContent = msg
      bar.style.width = '100%'
      bar.style.background = '#51cf66'
      currentToast = null
      hideTimer = setTimeout(() => api.dismiss(), 2500)
    },
    error(msg: string) {
      if (dismissed) return
      text.textContent = msg
      bar.style.width = '100%'
      bar.style.background = '#ff6b6b'
      currentToast = null
      hideTimer = setTimeout(() => api.dismiss(), 5000)
    },
    dismiss() {
      if (dismissed) return
      dismissed = true
      if (hideTimer) clearTimeout(hideTimer)
      if (currentToast && currentToast.el === el) currentToast = null
      el.remove()
    },
  }

  currentToast = api as any
  return api
}
