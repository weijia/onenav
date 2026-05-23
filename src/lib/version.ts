export const VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
export const BUILD_TIME = import.meta.env.VITE_APP_BUILD_TIME || new Date().toISOString()
export const COMMIT_SHA = import.meta.env.VITE_APP_COMMIT_SHA || 'unknown'

export const versionDisplay = `${VERSION} (${COMMIT_SHA})`
export const buildTimeDisplay = new Date(BUILD_TIME).toLocaleString('zh-CN')
