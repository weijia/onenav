/**
 * 手动「强制检查页面更新」。
 *
 * 为什么不直接用 `registration.update()`：
 *  - Service Worker 只做 SW 脚本本身的更新检查，sw.js 404 / MIME 错误 / 注册失败 /
 *    浏览器禁用 SW / 更新请求被缓存或超时时，`updatefound` 永不触发，用户看不到任何提示；
 *  - 页面加载时才有 3 秒后 + 每 5 分钟的自动检查，用户想立刻确认「线上是否已更新」只能等。
 *
 * 因此这里做双通道检查，任一通道可用即可得出结论：
 *  1. **版本清单通道（不依赖 SW）**：`fetch('<站点根>/version.json', {cache:'no-store'})`，
 *     与编译进本包的 `version.json`（sha/buildTime）比对。站点根由当前 URL 推导
 *     （`/apps/<id>/index.html` 会退两级），所以主页与所有独立应用页共用同一份清单。
 *  2. **SW 通道**：`getRegistration()` + `update()`，轮询 `reg.waiting` 判断新 Worker 是否已装好；
 *     同时探测 `sw.js` 的可访问性与 MIME，把「SW 异常」作为可见的诊断信息返回。
 *
 * `version.json` 由 vite 插件在构建时写到 dist 根目录，并且**排除在 SW 预缓存之外**，
 * 保证 `no-store` 请求真的走网络，不会读到 SW 缓存里的旧清单。
 */

import localVersion from '@/version.json'

export interface VersionMeta {
  version?: string
  buildTime?: string
  sha?: string
  branch?: string
  tag?: string
}

export interface SwProbeState {
  /** 浏览器是否支持 Service Worker */
  supported: boolean
  /** 是否已存在注册（同一站点根） */
  registered: boolean
  /** 是否已有等待激活的新 Worker（= 新版本已下载） */
  waiting: boolean
  /** 检查更新过程中的错误（不影响版本清单通道的结论） */
  error: string | null
  /** sw.js 是否不可用（404 / 非 JS MIME），此时 SW 通道永久失效 */
  brokenScript: boolean
}

export type UpdateCheckStatus = 'update-available' | 'up-to-date' | 'unknown'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  /** 给用户看的一句话结论 */
  message: string
  /** 本包编译进去的版本 */
  local: VersionMeta
  /** 远端 version.json（取不到为 null） */
  remote: VersionMeta | null
  /** 远端清单地址，便于排查部署路径 */
  remoteUrl: string
  sw: SwProbeState
  /** 远端是否可达（与 status 独立：SW 通道也可给出 update-available） */
  remoteReachable: boolean
  checkedAt: string
}

const LOCAL_META: VersionMeta = {
  version: localVersion.version,
  buildTime: localVersion.buildTime,
  sha: localVersion.sha,
  branch: localVersion.branch,
  tag: localVersion.tag,
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 推导站点根（返回以 `/` 结尾的绝对地址）。
 *
 * 独立应用页位于 `/apps/<id>/index.html`（可能还带子目录部署前缀，如 `/repo/apps/golf/`），
 * 需要回退两级才是站点根；主页 `/` 或 `/index.html` 就是根。
 * 取不到 location（单测/非浏览器环境）时退化为 `'./'`。
 */
export function resolveSiteRoot(loc?: { origin?: string; pathname?: string }): string {
  const l =
    loc ??
    (typeof window !== 'undefined'
      ? window.location
      : (globalThis as unknown as { location?: { origin?: string; pathname?: string } }).location)

  if (!l || typeof l.pathname !== 'string') return './'
  const origin = l.origin || ''
  const pathname = l.pathname

  // /…/apps/<id>/ 或 /…/apps/<id>/index.html → 截到 apps 之前
  const m = pathname.match(/\/apps\/[^/]+\/(?:index\.html?)?$/)
  if (m && m.index != null) {
    const dir = pathname.slice(0, m.index + 1) || '/'
    return origin ? `${origin}${dir}` : dir
  }

  // 其余情况：去掉最后一段文件名（如 /index.html → /）
  const dir = pathname.replace(/[^/]*$/, '') || '/'
  return origin ? `${origin}${dir}` : dir
}

async function fetchVersionMeta(url: string, timeoutMs = 8000): Promise<VersionMeta> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const data = JSON.parse(text) as VersionMeta
    if (!data || typeof data !== 'object') throw new Error('version.json 内容不是对象')
    return data
  } finally {
    clearTimeout(timer)
  }
}

function getServiceWorkerContainer(): ServiceWorkerContainer | null {
  const nav = (globalThis as unknown as { navigator?: Navigator }).navigator
  if (!nav || !('serviceWorker' in nav)) return null
  return nav.serviceWorker
}

/** 探测 sw.js 本身是否可被浏览器当脚本使用（404 / HTML 错误页 / 非 JS MIME 都算坏） */
async function probeSwScript(rootUrl: string): Promise<boolean> {
  if (typeof fetch !== 'function') return false
  try {
    const res = await fetch(new URL('sw.js', rootUrl).href, { cache: 'no-store' })
    if (!res.ok) return true
    const type = (res.headers.get('content-type') || '').toLowerCase()
    return !type.includes('javascript')
  } catch {
    return true
  }
}

/**
 * SW 通道：尝试让浏览器重新检查 sw.js，并看是否装好了等待中的新 Worker。
 * 任何异常都只记录在返回结构里，不抛出——检查更新不应因 SW 故障而整体失败。
 */
export async function probeServiceWorker(
  rootUrl: string,
  timeoutMs = 10000,
): Promise<SwProbeState> {
  const container = getServiceWorkerContainer()
  if (!container) {
    return {
      supported: false,
      registered: false,
      waiting: false,
      error: '浏览器不支持或已禁用 Service Worker',
      brokenScript: await probeSwScript(rootUrl),
    }
  }

  let reg: ServiceWorkerRegistration | null = null
  try {
    reg = (await container.getRegistration(rootUrl)) || (await container.getRegistration()) || null
  } catch (err) {
    reg = null
    // 取注册失败不致命，继续走版本清单通道
  }

  if (!reg) {
    return {
      supported: true,
      registered: false,
      waiting: false,
      error: '未找到 Service Worker 注册',
      brokenScript: await probeSwScript(rootUrl),
    }
  }

  let error: string | null = null
  try {
    const updates = reg.update()
    const outcome = await Promise.race([
      updates.then(() => 'done' as const).catch((err: unknown) => {
        error = errorMessage(err)
        return 'failed' as const
      }),
      sleep(timeoutMs).then(() => 'timeout' as const),
    ])
    if (outcome === 'timeout') error = `检查更新超时（>${Math.round(timeoutMs / 1000)}s）`
  } catch (err) {
    error = errorMessage(err)
  }

  // update() 返回后 Worker 可能还在 installing，短暂轮询到 installed/waiting
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (reg.waiting) break
    const installing = reg.installing
    if (installing && installing.state === 'installed' && container.controller) break
    if (!installing && !reg.waiting) break
    await sleep(250)
  }

  const waiting = !!reg.waiting || (!!reg.installing && reg.installing.state === 'installed' && !!container.controller)

  return {
    supported: true,
    registered: true,
    waiting,
    error,
    brokenScript: waiting ? false : await probeSwScript(rootUrl),
  }
}

function metaDiffers(local: VersionMeta, remote: VersionMeta): boolean {
  if (remote.sha && local.sha && remote.sha !== local.sha) return true
  if (remote.buildTime && local.buildTime && remote.buildTime !== local.buildTime) return true
  // 远端没有可比字段时视为无法判断（交给调用方按 unknown 处理）
  return false
}

/**
 * 检查是否有新版本。永不抛出：网络/SW 故障都会体现在 status/message 里。
 */
export async function checkForUpdate(options?: {
  rootUrl?: string
  timeoutMs?: number
}): Promise<UpdateCheckResult> {
  const rootUrl = options?.rootUrl || resolveSiteRoot()
  const remoteUrl = new URL('version.json', rootUrl).href

  let remote: VersionMeta | null = null
  let remoteError: string | null = null
  try {
    remote = await fetchVersionMeta(remoteUrl, options?.timeoutMs ?? 8000)
  } catch (err) {
    remoteError = errorMessage(err)
  }

  const sw = await probeServiceWorker(rootUrl, options?.timeoutMs ?? 10000)
  const checkedAt = new Date().toISOString()

  if (sw.waiting) {
    return {
      status: 'update-available',
      message: '后台已下载新版本，点击「立即更新」生效',
      local: LOCAL_META,
      remote,
      remoteUrl,
      sw,
      remoteReachable: !!remote,
      checkedAt,
    }
  }

  if (remote) {
    if (metaDiffers(LOCAL_META, remote)) {
      const label = remote.version || remote.sha || '新版本'
      const time = remote.buildTime ? `（${remote.buildTime}）` : ''
      return {
        status: 'update-available',
        message: `发现新版本 ${label}${time}`,
        local: LOCAL_META,
        remote,
        remoteUrl,
        sw,
        remoteReachable: true,
        checkedAt,
      }
    }
    return {
      status: 'up-to-date',
      message: `已是最新版本${LOCAL_META.buildTime ? `（${LOCAL_META.buildTime}）` : ''}`,
      local: LOCAL_META,
      remote,
      remoteUrl,
      sw,
      remoteReachable: true,
      checkedAt,
    }
  }

  // 远端清单拿不到，且 SW 也没有新 Worker：老实说无法确认，并给出可诊断的原因
  const details: string[] = [`远端版本清单不可用：${remoteError || '未知原因'}`]
  if (sw.error) details.push(`SW 更新检查：${sw.error}`)
  if (sw.brokenScript) details.push('sw.js 不可用或 MIME 不是 JavaScript')
  if (!sw.supported) details.push('当前浏览器不支持 Service Worker')

  return {
    status: 'unknown',
    message: `无法确认是否有更新（${details.join('；')}）`,
    local: LOCAL_META,
    remote: null,
    remoteUrl,
    sw,
    remoteReachable: false,
    checkedAt,
  }
}

function reloadWithBuster() {
  if (typeof location === 'undefined') return
  try {
    const url = new URL(location.href)
    url.searchParams.set('_u', Date.now().toString(36))
    location.replace(url.toString())
  } catch {
    location.reload()
  }
}

function waitForControllerChange(timeoutMs = 3000): Promise<void> {
  const container = getServiceWorkerContainer()
  if (!container) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      container.removeEventListener('controllerchange', done)
      resolve()
    }
    container.addEventListener('controllerchange', done)
    setTimeout(done, timeoutMs)
  })
}

/**
 * 应用更新：
 *  - 有 waiting Worker → 发 SKIP_WAITING，等 controllerchange 后带防缓存参数重载；
 *  - 没有（SW 异常/未注册，例如后台更新失败）→ 注销 SW、清空 Cache Storage，
 *    再带防缓存参数重载，确保下一次请求真正走网络拿到新页面。
 */
export async function applyUpdate(rootUrl?: string): Promise<void> {
  const container = getServiceWorkerContainer()
  const root = rootUrl || resolveSiteRoot()

  if (container) {
    let reg: ServiceWorkerRegistration | null = null
    try {
      reg = (await container.getRegistration(root)) || (await container.getRegistration()) || null
    } catch {
      reg = null
    }

    if (reg?.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      await waitForControllerChange()
      reloadWithBuster()
      return
    }

    // SW 通道失效：清理过期缓存与注册，避免旧 sw.js 继续返回旧页面
    try {
      const regs = (await container.getRegistrations?.()) || (reg ? [reg] : [])
      await Promise.all(regs.map((r) => r.unregister()))
    } catch {
      /* 注销失败也继续重载 */
    }
  }

  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* 缓存不可用时忽略 */
  }

  reloadWithBuster()
}
