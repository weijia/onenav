/**
 * RemoteStorage 同步模块
 * 
 * 使用 universal-sync-v2 将 PouchDB 数据同步到 RemoteStorage
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'

// 动态导入 universal-sync-v2 浏览器版本
let syncModule: any = null

async function getSyncModule(): Promise<any> {
  if (!syncModule) {
    // 使用浏览器版本
    syncModule = await import('universal-sync-v2/dist/browser.js' as any)
  }
  return syncModule
}

let isConfigured = false
let syncInProgress = false
let currentFs: RemoteStorageFileSystem | null = null

/**
 * RemoteStorage 连接配置
 */
export interface RemoteStorageConnectionConfig {
  /** RemoteStorage 存储地址，如 https://storage.5apps.com/weijia/ */
  href: string
  /** Bearer token */
  token: string
  /** 请求超时（毫秒） */
  timeout?: number
}

/**
 * 同步选项
 */
export interface RemoteStorageSyncOptions {
  /** 最大文件大小（字节），默认 500KB */
  maxFileSize?: number
  /** 合并阈值（字节），默认 50KB */
  mergeThreshold?: number
  /** 是否自动合并 */
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

  // 创建 RemoteStorage 文件系统实例
  currentFs = new RemoteStorageFileSystem(rsConfig)
  isConfigured = true
}

/**
 * 将 PouchDB 同步到 RemoteStorage
 * 
 * @param db PouchDB 数据库实例
 * @param config RemoteStorage 连接配置
 * @param options 同步选项
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

    // 确保已配置
    await configureRemoteStorage(config)

    if (!currentFs) {
      throw new Error('文件系统未初始化')
    }

    const { sync } = await getSyncModule()

    // basePath 使用模块名 'onenav'
    // universal-sync-v2 会生成路径: /onenav/data/2026/05/manifest.json
    // RemoteStorageFileSystem 会转换为: https://storage.5apps.com/weijia/onenav/data/2026/05/manifest.json
    await sync(db, currentFs as any, '/onenav', {
      maxFileSize: options.maxFileSize ?? 500 * 1024,
      mergeThreshold: options.mergeThreshold ?? 50 * 1024,
      autoMerge: options.autoMerge ?? true,
    })
  } finally {
    syncInProgress = false
  }
}

/**
 * 创建同步引擎实例（用于更细粒度的控制）
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

  const { SyncEngine } = await getSyncModule()

  const engine = new SyncEngine(db, currentFs as any, {
    basePath: '/onenav',
    maxFileSize: options.maxFileSize ?? 500 * 1024,
    mergeThreshold: options.mergeThreshold ?? 50 * 1024,
    autoMerge: options.autoMerge ?? true,
  })

  await engine.initialize()
  return engine
}

/**
 * 检查是否已配置
 */
export function isRemoteStorageConfigured(): boolean {
  return isConfigured
}

/**
 * 检查是否正在同步
 */
export function isSyncing(): boolean {
  return syncInProgress
}

/**
 * 重置配置（用于测试）
 */
export function resetRemoteStorageConfig(): void {
  isConfigured = false
  syncInProgress = false
  currentFs = null
}
