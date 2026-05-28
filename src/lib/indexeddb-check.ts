/**
 * 直接读取 IndexedDB 检查 PouchDB 数据
 */

export async function checkIndexedDB(): Promise<void> {
  console.log('[IndexedDB Check] 开始检查...')
  
  try {
    // 打开 PouchDB 数据库
    const request = indexedDB.open('_pouch_onenav')
    
    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      console.log('[IndexedDB Check] 数据库打开成功:', db.name)
      console.log('[IndexedDB Check] 对象存储:', Array.from(db.objectStoreNames))
      
      // 读取 by-sequence 存储（PouchDB 内部存储）
      try {
        const transaction = db.transaction(['by-sequence'], 'readonly')
        const store = transaction.objectStore('by-sequence')
        const cursorRequest = store.openCursor()
        
        const docs: any[] = []
        cursorRequest.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest).result
          if (cursor) {
            const value = cursor.value
            // 查找 cfg:app 文档
            if (value.id === 'cfg:app' || (value.data && value.data._id === 'cfg:app')) {
              console.log('[IndexedDB Check] 找到 cfg:app 原始数据:', value)
              docs.push(value)
            }
            cursor.continue()
          } else {
            console.log('[IndexedDB Check] 扫描完成，找到文档数:', docs.length)
            if (docs.length > 0) {
              const doc = docs[0]
              console.log('[IndexedDB Check] 文档 data 字段:', doc.data)
              console.log('[IndexedDB Check] 文档 data.tags:', doc.data?.tags)
              if (doc.data?.tags?.length > 0) {
                console.log('[IndexedDB Check] 第一个 tag:', doc.data.tags[0])
                console.log('[IndexedDB Check] 第一个 tag 的所有属性:', Object.keys(doc.data.tags[0]))
              }
            }
          }
        }
        
        cursorRequest.onerror = (e) => {
          console.error('[IndexedDB Check] 游标错误:', e)
        }
      } catch (err) {
        console.error('[IndexedDB Check] 读取 by-sequence 失败:', err)
      }
      
      // 也尝试读取 by-id 存储
      try {
        const transaction2 = db.transaction(['by-id'], 'readonly')
        const store2 = transaction2.objectStore('by-id')
        const getRequest = store2.get('cfg:app')
        
        getRequest.onsuccess = (e) => {
          const result = (e.target as IDBRequest).result
          console.log('[IndexedDB Check] by-id cfg:app:', result)
        }
        
        getRequest.onerror = (e) => {
          console.error('[IndexedDB Check] by-id 读取错误:', e)
        }
      } catch (err) {
        console.error('[IndexedDB Check] 读取 by-id 失败:', err)
      }
    }
    
    request.onerror = (event) => {
      console.error('[IndexedDB Check] 数据库打开失败:', event)
    }
  } catch (err) {
    console.error('[IndexedDB Check] 错误:', err)
  }
}
