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
 */
export async function loadFromRemoteStorage(
  db: PouchDB.Database,
  config: RemoteStorageConfig
): Promise<{ errors: string[] }> {
  const errors: string[] = []

  try {
    // 记录 pull 前 PouchDB 状态
    const infoBefore = await db.info()
    console.log('[RS Load] PouchDB pull 前:', { doc_count: infoBefore.doc_count, update_seq: infoBefore.update_seq })

    console.log('[RS Load] 创建 SyncEngine...')
    const fs = new RemoteStorageFileSystem(config)
    const { SyncEngine } = await getSyncModule()
    
    const engine = new SyncEngine(db, fs, {
      basePath: '/onenav',
      maxFileSize: 500 * 1024,
    })

    console.log('[RS Load] 初始化...')
    await engine.initialize()
    
    console.log('[RS Load] 执行 pull...')
    await engine.pull()

    // 记录 pull 后 PouchDB 状态
    const infoAfter = await db.info()
    console.log('[RS Load] PouchDB pull 后:', { doc_count: infoAfter.doc_count, update_seq: infoAfter.update_seq })
    
    // 列出所有文档
    const allDocs = await db.allDocs({ include_docs: false, limit: 20 })
    console.log('[RS Load] PouchDB 文档列表 (前20):', allDocs.rows.map(r => r.id))

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
  console.log('[RS Check] 直接返回 true，由 pull() 判断')
  return true
}
