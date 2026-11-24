// 「强制检查更新」回归测试。
//
// 关键契约：
//  1. 站点根推导：/apps/<id>/index.html（含子目录部署前缀）要回退两级，否则独立应用页会去取
//     /apps/golf/version.json（不存在）而误判「无法确认」。
//  2. 版本清单通道不依赖 SW：浏览器没有/禁用 SW 时，只要远端 version.json 与本地不同就要报可更新。
//  3. SW 通道独立有效：远端清单取不到但已有 waiting Worker 时，仍要报可更新（sw.js 更新成功但清单异常）。
//  4. 两个通道都失败时返回 unknown 且给出可诊断原因，绝不抛异常。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyUpdate, checkForUpdate, resolveSiteRoot } from './update-check'
import localVersion from '@/version.json'

interface FakeResponse {
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  text: () => Promise<string>
}

function jsonResponse(data: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(data),
  }
}

function jsResponse(): FakeResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/javascript' : null) },
    text: async () => 'self.addEventListener("install",()=>{})',
  }
}

function textResponse(text: string, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => text,
  }
}

/** 按 URL 路由的 fetch 桩：version.json 用给定响应，sw.js 默认正常 */
function stubFetch(handlers: { version?: () => Promise<FakeResponse>; sw?: () => Promise<FakeResponse> }) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('version.json')) {
      if (handlers.version) return handlers.version()
      return jsonResponse({ ...localVersion })
    }
    if (url.endsWith('sw.js')) {
      if (handlers.sw) return handlers.sw()
      return jsResponse()
    }
    return textResponse('not found', 404)
  })
}

function stubWindow(pathname = '/apps/golf/index.html', origin = 'https://onenav.example') {
  vi.stubGlobal('window', { location: { origin, pathname } })
}

/** 伪造一个已注册、且带 waiting Worker 的 SW 容器 */
function stubWaitingServiceWorker(): void {
  const reg = {
    waiting: { postMessage: vi.fn() },
    installing: null,
    update: async () => undefined,
    unregister: async () => true,
  }
  vi.stubGlobal('navigator', {
    serviceWorker: {
      controller: {},
      getRegistration: async () => reg,
      getRegistrations: async () => [reg],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveSiteRoot', () => {
  it('主页与其 index.html 都解析为站点根', () => {
    expect(resolveSiteRoot({ origin: 'https://a.example', pathname: '/' })).toBe('https://a.example/')
    expect(resolveSiteRoot({ origin: 'https://a.example', pathname: '/index.html' })).toBe(
      'https://a.example/',
    )
  })

  it('独立应用页回退两级（含子目录部署前缀）', () => {
    expect(
      resolveSiteRoot({ origin: 'https://a.example', pathname: '/apps/golf/index.html' }),
    ).toBe('https://a.example/')
    expect(
      resolveSiteRoot({ origin: 'https://a.example', pathname: '/repo/apps/golf/index.html' }),
    ).toBe('https://a.example/repo/')
    expect(resolveSiteRoot({ origin: 'https://a.example', pathname: '/apps/note-editor/' })).toBe(
      'https://a.example/',
    )
  })

  it('取不到 location 时退化为相对路径', () => {
    expect(resolveSiteRoot({} as { pathname?: string })).toBe('./')
  })
})

describe('checkForUpdate', () => {
  it('远端版本与本地一致 → up-to-date（没有 SW 也能得出结论）', async () => {
    stubWindow()
    stubFetch({})
    // Node 没有 navigator.serviceWorker
    const r = await checkForUpdate({ rootUrl: 'https://a.example/' })
    expect(r.status).toBe('up-to-date')
    expect(r.remoteReachable).toBe(true)
    expect(r.sw.supported).toBe(false)
    expect(r.message).toContain('已是最新')
  })

  it('远端 buildTime/sha 不同 → update-available（版本清单通道，不依赖 SW）', async () => {
    stubWindow()
    stubFetch({
      version: async () =>
        jsonResponse({ ...localVersion, sha: 'deadbeef', buildTime: '2099/01/01 00:00:00' }),
    })
    const r = await checkForUpdate({ rootUrl: 'https://a.example/' })
    expect(r.status).toBe('update-available')
    expect(r.message).toContain('发现新版本')
    expect(r.remote?.sha).toBe('deadbeef')
    expect(r.sw.supported).toBe(false)
  })

  it('远端清单不可用但 SW 已有 waiting Worker → 仍报可更新', async () => {
    stubWindow()
    stubWaitingServiceWorker()
    stubFetch({
      version: async () => textResponse('server error', 500),
    })
    const r = await checkForUpdate({ rootUrl: 'https://a.example/' })
    expect(r.status).toBe('update-available')
    expect(r.message).toContain('后台已下载新版本')
    expect(r.sw.waiting).toBe(true)
    expect(r.remoteReachable).toBe(false)
  })

  it('两个通道都失败 → unknown 且说明原因（不抛异常）', async () => {
    stubWindow()
    stubFetch({
      version: async () => Promise.reject(new Error('Failed to fetch')),
      sw: async () => textResponse('<html>404</html>', 404),
    })
    const r = await checkForUpdate({ rootUrl: 'https://a.example/' })
    expect(r.status).toBe('unknown')
    expect(r.message).toContain('远端版本清单不可用')
    expect(r.message).toContain('Failed to fetch')
    expect(r.sw.brokenScript).toBe(true)
  })

  it('远端 version.json 404（旧部署）也给出明确结论而不是静默失败', async () => {
    stubWindow()
    stubFetch({ version: async () => textResponse('Not Found', 404) })
    const r = await checkForUpdate({ rootUrl: 'https://a.example/' })
    expect(r.status).toBe('unknown')
    expect(r.message).toContain('HTTP 404')
    expect(r.remoteUrl).toBe('https://a.example/version.json')
  })
})

describe('applyUpdate', () => {
  it('有 waiting Worker → 发 SKIP_WAITING，controllerchange 后带防缓存参数重载', async () => {
    const postMessage = vi.fn()
    const reg = {
      waiting: { postMessage },
      installing: null,
      unregister: vi.fn(async () => true),
    }
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {},
        getRegistration: async () => reg,
        getRegistrations: async () => [reg],
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        removeEventListener: () => undefined,
      },
    })
    const replace = vi.fn()
    vi.stubGlobal('location', {
      href: 'https://a.example/apps/golf/index.html?x=1',
      replace,
      reload: vi.fn(),
    })

    const pending = applyUpdate('https://a.example/')
    // 模拟浏览器激活新 Worker
    await Promise.resolve()
    listeners.get('controllerchange')?.()
    await pending

    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(String(replace.mock.calls[0][0])).toContain('_u=')
  })

  it('没有 waiting Worker（SW 异常）→ 注销注册 + 清缓存后重载', async () => {
    const unregister = vi.fn(async () => true)
    const reg = { waiting: null, installing: null, unregister }
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: null,
        getRegistration: async () => reg,
        getRegistrations: async () => [reg],
      },
    })
    const deleted: string[] = []
    vi.stubGlobal('caches', {
      keys: async () => ['workbox-precache-v2', 'golf-tiles-v1'],
      delete: async (k: string) => {
        deleted.push(k)
        return true
      },
    })
    const replace = vi.fn()
    vi.stubGlobal('location', { href: 'https://a.example/', replace, reload: vi.fn() })

    await applyUpdate('https://a.example/')

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(deleted).toContain('workbox-precache-v2')
    expect(deleted).toContain('golf-tiles-v1')
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
