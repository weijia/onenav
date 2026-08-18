/**
 * RemoteStorage 同步模块
 * 
 * 使用 universal-sync-v2 将 PouchDB 数据同步到 RemoteStorage
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'
import { resolveOneNavSyncConflict } from './bookmark-conflicts'
import { showSyncToast, type SyncToast } from './sync-notify'
import { getStorageCredentials } from './remotestorage-connection'

let SyncEngine: any = null

async function getSyncEngine(): Promise<any> {
  if (!SyncEngine) {
    // 动态导入 universal-sync-v2 浏览器版本
    const module = await import('universal-sync-v2/browser')
    SyncEngine = module.SyncEngine
  }
  return SyncEngine
}

let isConfigured = false
let syncInProgress = false
let currentFs: RemoteStorageFileSystem | null = null

/**
 * RemoteStorage 连接配置
 */
export interface RemoteStorageConnectionConfig {
  href: string
  token: string
  timeout?: number
}

/**
 * 同步选项
 */
export interface RemoteStorageSyncOptions {
  maxFileSize?: number
  mergeThreshold?: number
  autoMerge?: boolean
  /** 进度回调：业务层可借此展示「服务器剩余 N 个文件」「本地 M 条待上传」等（可选，不传则使用默认 toast） */
  onProgress?: (progress: any) => void
  /** 是否显示内置进度 toast（默认 true）；若自行传入 onProgress 处理展示可设 false */
  showToast?: boolean
}

/**
 * 将 universal-sync-v2 的 SyncProgress 转成 toast 提示。
 * 计算各阶段的进度比例：
 *  - pull：remoteFilesRead / remoteFilesTotal
 *  - push：localFilesWritten / localFilesTotal
 */
function bindProgressToast(toast: SyncToast, onProgress?: (p: any) => void): (p: any) => void {
  return (p: any) => {
    let msg = p.message
    let ratio: number | undefined
    if (p.phase === 'pull') {
      if (p.remoteFilesTotal && p.remoteFilesRead != null) {
        ratio = p.remoteFilesTotal ? p.remoteFilesRead / p.remoteFilesTotal : undefined
        msg = msg || `已从服务器读取 ${p.remoteFilesRead}/${p.remoteFilesTotal} 个文件（剩余 ${p.remoteFilesTotal - p.remoteFilesRead} 个待读取）`
      } else if (p.localPendingToApply != null) {
        msg = msg || `本地有 ${p.localPendingToApply} 条记录待写入`
      }
    } else if (p.phase === 'push') {
      if (p.localFilesTotal && p.localFilesWritten != null) {
        ratio = p.localFilesTotal ? p.localFilesWritten / p.localFilesTotal : undefined
        msg = msg || `已上传 ${p.localFilesWritten}/${p.localFilesTotal} 个文件（剩余 ${p.localFilesTotal - p.localFilesWritten} 个待上传）`
      } else if (p.localDocsTotal != null) {
        msg = msg || `本地有 ${p.localDocsTotal} 条记录待上传`
      }
    }
    if (msg) toast.update(msg, ratio)
    if (p.phase === 'done') toast.finish(p.message || '同步完成')
    if (p.phase === 'skip') toast.finish(p.message || '无需同步（无变更）')
    if (p.phase === 'error') toast.error(p.message || '同步出错')
    onProgress?.(p)
  }
}

/**
 * 配置 RemoteStorage 文件系统
 */
export async function configureRemoteStorage(config: RemoteStorageConnectionConfig): Promise<void> {
  if (isConfigured && currentFs) {
    return
  }

  const rsConfig: RemoteStorageConfig = {
    href: config.href,
    token: config.token,
    timeout: config.timeout || 30000,
  }

  currentFs = new RemoteStorageFileSystem(rsConfig)
  isConfigured = true
}

/**
 * 将 PouchDB 同步到 RemoteStorage
 */
export async function syncToRemoteStorage(
  db: PouchDB.Database,
  config: RemoteStorageConnectionConfig,
  options: RemoteStorageSyncOptions = {}
): Promise<void> {
  if (syncInProgress) {
    throw new Error('同步正在进行中')
  }

  try {
    syncInProgress = true

    await configureRemoteStorage(config)

    if (!currentFs) {
      throw new Error('文件系统未初始化')
    }

    const Engine = await getSyncEngine()

    const toast = options.showToast === false ? null : showSyncToast('准备同步…')
    const onProgress = toast ? bindProgressToast(toast, options.onProgress) : options.onProgress

    const engine = new Engine(db, currentFs as any, {
      basePath: '/onenav',
      maxFileSize: options.maxFileSize ?? 500 * 1024,
      mergeThreshold: options.mergeThreshold ?? 50 * 1024,
      autoMerge: options.autoMerge ?? true,
      conflictResolver: resolveOneNavSyncConflict,
      onProgress,
    })

    await engine.initialize()
    await engine.sync()
  } catch (err) {
    if (options.showToast !== false) {
      showSyncToast('同步失败').error(String(err))
    }
    throw err
  } finally {
    syncInProgress = false
  }
}

/**
 * 创建同步引擎实例
 */
export async function createSyncEngine(
  db: PouchDB.Database,
  config: RemoteStorageConnectionConfig,
  options: RemoteStorageSyncOptions = {}
): Promise<any> {
  await configureRemoteStorage(config)

  if (!currentFs) {
    throw new Error('文件系统未初始化')
  }

  const Engine = await getSyncEngine()

  const toast = options.showToast === false ? null : showSyncToast('准备同步…')
  const onProgress = toast ? bindProgressToast(toast, options.onProgress) : options.onProgress

  const engine = new Engine(db, currentFs as any, {
    basePath: '/onenav',
    maxFileSize: options.maxFileSize ?? 500 * 1024,
    mergeThreshold: options.mergeThreshold ?? 50 * 1024,
    autoMerge: options.autoMerge ?? true,
    conflictResolver: resolveOneNavSyncConflict,
    onProgress,
  })

  await engine.initialize()
  return engine
}

export function isRemoteStorageConfigured(): boolean {
  return isConfigured
}

export function isSyncing(): boolean {
  return syncInProgress
}

export function resetRemoteStorageConfig(): void {
  isConfigured = false
  syncInProgress = false
  currentFs = null
}

/**
 * 保存数据后的「自动同步」：若已配置 RemoteStorage，则 debounce 后自动 push 一次。
 * 这样本地书签/配置保存后会自动上传到服务器（无需手动点同步）。
 * 使用 debounce 合并短时间内多次保存（例如批量导入书签），避免频繁触发同步。
 */
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null
export async function scheduleAutoSync(db: PouchDB.Database, delay = 1500): Promise<void> {
  if (!isConfigured) return
  if (autoSyncTimer) clearTimeout(autoSyncTimer)
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null
    try {
      const creds = getStorageCredentials()
      if (!creds) return
      console.log('[RS Sync] 自动同步（保存后 push）…')
      await syncToRemoteStorage(db, creds, { showToast: true })
    } catch (err) {
      console.error('[RS Sync] 自动同步失败（已忽略）:', err)
    }
  }, delay)
}
