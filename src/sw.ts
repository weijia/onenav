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
