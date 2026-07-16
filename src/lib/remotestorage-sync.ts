/**
 * RemoteStorage 同步模块
 * 
 * 使用 universal-sync-v2 将 PouchDB 数据同步到 RemoteStorage
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'
import { resolveOneNavSyncConflict } from './bookmark-conflicts'

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

    const engine = new Engine(db, currentFs as any, {
      basePath: '/onenav',
      maxFileSize: options.maxFileSize ?? 500 * 1024,
      mergeThreshold: options.mergeThreshold ?? 50 * 1024,
      autoMerge: options.autoMerge ?? true,
      conflictResolver: resolveOneNavSyncConflict,
    })

    await engine.initialize()
    await engine.sync()
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

  const engine = new Engine(db, currentFs as any, {
    basePath: '/onenav',
    maxFileSize: options.maxFileSize ?? 500 * 1024,
    mergeThreshold: options.mergeThreshold ?? 50 * 1024,
    autoMerge: options.autoMerge ?? true,
    conflictResolver: resolveOneNavSyncConflict,
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
