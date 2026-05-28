/**
 * 重置 PouchDB 数据库
 * 用于解决 IndexedDB 结构损坏问题
 */

export async function resetPouchDB(): Promise<void> {
  console.log('[PouchDB Reset] 开始重置数据库...')
  
  try {
    // 删除 PouchDB 的 IndexedDB 数据库
    const request = indexedDB.deleteDatabase('_pouch_onenav')
    
    request.onsuccess = () => {
      console.log('[PouchDB Reset] 数据库删除成功')
    }
    
    request.onerror = (event) => {
      console.error('[PouchDB Reset] 数据库删除失败:', event)
    }
    
    request.onblocked = () => {
      console.warn('[PouchDB Reset] 数据库删除被阻塞，请关闭其他标签页后重试')
    }
  } catch (err) {
    console.error('[PouchDB Reset] 错误:', err)
  }
}

/**
 * 检查 PouchDB 数据库是否存在
 */
export async function checkPouchDBExists(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('_pouch_onenav')
      
      request.onsuccess = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        const exists = db.objectStoreNames.length > 0
        console.log('[PouchDB Check] 数据库存在，对象存储:', Array.from(db.objectStoreNames))
        db.close()
        resolve(exists)
      }
      
      request.onerror = () => {
        console.log('[PouchDB Check] 数据库不存在或无法访问')
        resolve(false)
      }
      
      request.onupgradeneeded = (event) => {
        console.log('[PouchDB Check] 数据库需要升级（新数据库）')
      }
    } catch (err) {
      console.error('[PouchDB Check] 错误:', err)
      resolve(false)
    }
  })
}
