/**
 * 从 RemoteStorage 加载数据到 PouchDB
 * 
 * 直接使用 universal-sync-v2 的 SyncEngine.pull() 方法
 */

import { RemoteStorageFileSystem } from './remotestorage-fs'
import type { RemoteStorageConfig } from './remotestorage-fs'

// 动态导入 universal-sync-v2 浏览器版本
let syncModule: any = null

async function getSyncModule(): Promise<any> {
  if (!syncModule) {
    syncModule = await import('universal-sync-v2/dist/browser.js' as any)
  }
  return syncModule
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
    const fs = new RemoteStorageFileSystem(config)
    const { SyncEngine } = await getSyncModule()
    
    const engine = new SyncEngine(db, fs as any, {
      basePath: '/onenav',
      maxFileSize: 500 * 1024,
      autoMerge: false, // 加载时不需要合并
    })

    await engine.initialize()
    await engine.pull()

    console.log('[RS Load] 加载完成')
    return { count: 0, errors } // universal-sync-v2 内部处理计数
  } catch (err) {
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

  // 检查 manifest-index.json 或 manifest.json 是否存在
  try {
    await fs.readFile('/onenav/manifest-index.json', 'utf8')
    return true
  } catch {
    // ignore
  }

  try {
    await fs.readFile('/onenav/manifest.json', 'utf8')
    return true
  } catch {
    // ignore
  }

  return false
}
