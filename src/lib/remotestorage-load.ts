/**
 * 从 RemoteStorage 加载数据到 PouchDB
 * 
 * 使用 universal-sync-v2 的 SyncEngine
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'

// 动态导入 universal-sync-v2 浏览器版本
async function getSyncModule(): Promise<any> {
  return await import('universal-sync-v2/dist/browser.js' as any)
}

/**
 * 从 RemoteStorage 加载数据到 PouchDB
 * 
 * 直接调用 pull()，SyncEngine 会自动检查远程是否有数据并加载
 */
export async function loadFromRemoteStorage(
  db: PouchDB.Database,
  config: RemoteStorageConfig
): Promise<{ errors: string[] }> {
  const errors: string[] = []

  try {
    console.log('[RS Load] 创建 SyncEngine...')
    const fs = new RemoteStorageFileSystem(config)
    const { SyncEngine } = await getSyncModule()
    
    const engine = new SyncEngine(db, fs, {
      basePath: '/onenav',
      maxFileSize: 500 * 1024,
    })

    console.log('[RS Load] 初始化...')
    await engine.initialize()
    
    console.log('[RS Load] 执行 pull (检查并加载远程数据)...')
    await engine.pull()

    console.log('[RS Load] 完成')
    return { errors }
  } catch (err) {
    console.error('[RS Load] 失败:', err)
    errors.push(`加载失败: ${err}`)
    return { errors }
  }
}

/**
 * 检查 RemoteStorage 是否有数据
 */
export async function hasRemoteStorageData(
  _db: PouchDB.Database,
  _config: RemoteStorageConfig
): Promise<boolean> {
  // 直接返回 true，让 pull() 内部处理
  // SyncEngine 会自动检查远程是否有数据
  console.log('[RS Check] 直接返回 true，由 pull() 判断')
  return true
}
