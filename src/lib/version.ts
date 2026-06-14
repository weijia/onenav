export const VERSION = __APP_VERSION__ || 'dev'

// 构建时间通过 Vite define 注入，但 vite.config.ts 可能被缓存
// 使用 __APP_BUILD_TIME__ 替代 import.meta.env，确保每次构建更新
// eslint-disable-next-line
export const BUILD_TIME = (typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : new Date().toISOString()) as string

export const versionDisplay = VERSION
export const buildTimeDisplay = new Date(BUILD_TIME).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short'
})
