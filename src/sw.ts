/// <reference lib="WebWorker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

// 预缓存所有构建产物
precacheAndRoute(self.__WB_MANIFEST)

// 清理旧缓存
cleanupOutdatedCaches()

// 监听 SKIP_WAITING 消息
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

// ───────────────────────────────────────────────────────────
// 地图瓦片运行时缓存（高尔夫球场离线查看用）
//
// 缓存策略：CacheFirst —— 优先读缓存，未命中再走网络并写入缓存。
// 跨域瓦片响应通常是 opaque（status 0，读不到内容），但作为图片缓存与回放完全可用。
// 同时限制缓存条目上限，避免离线缓存无限膨胀占满用户存储配额。
// ───────────────────────────────────────────────────────────
const TILE_CACHE = 'golf-tiles-v1'
const TILE_HOSTS = ['is.autonavi.com', 'tile.openstreetmap.org']
const MAX_TILES = 3000

function isTileRequest(url: URL): boolean {
  return TILE_HOSTS.some((h) => url.hostname.endsWith(h))
}

/** 超出上限时从最旧开始清理 */
async function trimCache(cache: Cache, max: number) {
  const keys = await cache.keys()
  const extra = keys.length - max
  if (extra <= 0) return
  for (let i = 0; i < extra; i++) await cache.delete(keys[i])
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (!isTileRequest(url)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(TILE_CACHE)
      const cached = await cache.match(req)
      if (cached) return cached

      try {
        const res = await fetch(req)
        if (res && (res.ok || res.type === 'opaque')) {
          void cache.put(req, res.clone()).then(() => trimCache(cache, MAX_TILES))
        }
        return res
      } catch {
        // 离线且精确未命中：忽略查询串再试一次（瓦片 URL 常带参数）
        const fallback = await cache.match(req, { ignoreSearch: true })
        if (fallback) return fallback
        // 网络失败且无任何缓存兜底：返回离线占位响应而非抛错。
        // 瓦片请求是跨域 no-cors，主机不可达/离线时会抛 `TypeError: Failed to fetch`，
        // 若在此 throw，会形成 respondWith 里未处理的 promise rejection → Uncaught (in promise)。
        // 返回占位响应让 respondWith 始终 resolve，仅该块瓦片显示失败，不产生全局报错。
        return new Response('', {
          status: 504,
          statusText: 'Offline',
          headers: { 'Content-Type': 'image/png' },
        })
      }
    })(),
  )
})
