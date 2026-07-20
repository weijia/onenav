import versionInfo from '../version.json'

export const VERSION = versionInfo.version
export const BUILD_TIME = versionInfo.buildTime
export const COMMIT_SHA = versionInfo.sha
export const BRANCH = versionInfo.branch
export const TAG = versionInfo.tag

export const versionDisplay = TAG ? VERSION : `${VERSION}`
export const buildTimeDisplay = BUILD_TIME
