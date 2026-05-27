/**
 * 从 RemoteStorage 加载数据到 PouchDB
 * 
 * 使用 universal-sync-v2 的 SyncEngine.pull() 方法
 */

import { RemoteStorageFileSystem, type RemoteStorageConfig } from './remotestorage-fs'

// 动态导入 universal-sync-v2 浏览器版本
async function getSyncModule(): Promise<any> {
  return await import('universal-sync-v2/dist/browser.js' as any)
}

/**
 * 从 RemoteStorage 加载数据到 PouchDB
 */
export async function loadFromRemoteStorage(
  db: PouchDB.Database,
  config: RemoteStorageConfig
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = []

  try {
    console.log('[RS Load] 开始加载...')
    const fs = new RemoteStorageFileSystem(config)
    const { SyncEngine } = await getSyncModule()
    
    const engine = new SyncEngine(db, fs, {
      basePath: '/onenav',
      maxFileSize: 500 * 1024,
    })

    console.log('[RS Load] 初始化 SyncEngine...')
    await engine.initialize()
    
    console.log('[RS Load] 执行 pull...')
    await engine.pull()

    console.log('[RS Load] 加载完成')
    return { count: 0, errors }
  } catch (err) {
    console.error('[RS Load] 加载失败:', err)
    errors.push(`加载失败: ${err}`)
    return { count: 0, errors }
  }
}

/**
 * 检查 RemoteStorage 是否有数据
 */
export async function hasRemoteStorageData(
  config: RemoteStorageConfig
): Promise<boolean> {
  const fs = new RemoteStorageFileSystem(config)

  try {
    await fs.exists('/onenav/manifest-index.json')
    return true
  } catch {
    // ignore
  }

  try {
    await fs.exists('/onenav/manifest.json')
    return true
  } catch {
    // ignore
  }

  return false
}