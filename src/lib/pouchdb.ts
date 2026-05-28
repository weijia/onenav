const DB_NAME = 'onenav'
let db: any = null
let dbInitError = false

async function getDb(): Promise<any> {
  if (!db || dbInitError) {
    const PouchDB = (await import('pouchdb-browser')).default
    try {
      db = new PouchDB(DB_NAME)
      // 测试数据库是否正常工作
      await db.info()
      dbInitError = false
      console.log('[PouchDB] 数据库初始化成功')
    } catch (err) {
      console.error('[PouchDB] 数据库初始化失败，尝试重置:', err)
      dbInitError = true
      // 删除损坏的数据库
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('_pouch_' + DB_NAME)
        req.onsuccess = () => {
          console.log('[PouchDB] 损坏的数据库已删除')
          resolve()
        }
        req.onerror = () => {
          console.error('[PouchDB] 删除数据库失败')
          resolve()
        }
      })
      // 重新创建
      db = new PouchDB(DB_NAME)
      console.log('[PouchDB] 数据库重新创建成功')
    }
  }
  return db
}

/**
 * 获取 PouchDB 实例（用于同步）
 */
export async function getPouchDB(): Promise<PouchDB.Database> {
  return getDb()
}

// ==================== 文档 ID 前缀 ====================
const PREFIX = {
  BOOKMARK: 'bm:',
  CLICK: 'clk:',
  CONFIG: 'cfg:',
  META: 'meta:',
} as const

// ==================== 书签（每条一个文档）====================

export interface BookmarkDoc {
  _id: string
  _rev?: string
  type: 'bookmark'
  url: string
  title: string
  tags: string[]
  description?: string
  icon?: string
  clicks: number
  lastClickedAt?: number
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

export async function saveBookmark(bookmark: Omit<BookmarkDoc, '_id' | 'type'> & { url: string }): Promise<void> {
  const database = await getDb()
  const id = PREFIX.BOOKMARK + bookmark.url
  
  try {
    const existing = await database.get(id).catch(() => null)
    const doc: BookmarkDoc = {
      _id: id,
      type: 'bookmark',
      url: bookmark.url,
      title: bookmark.title,
      tags: bookmark.tags || [],
      description: bookmark.description,
      icon: bookmark.icon,
      clicks: bookmark.clicks || 0,
      lastClickedAt: bookmark.lastClickedAt,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      deleted: bookmark.deleted || false,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveBookmark error:', bookmark.url, err)
  }
}

export async function saveBookmarks(bookmarks: Array<Omit<BookmarkDoc, '_id' | 'type'>>): Promise<void> {
  console.log('[PouchDB] saveBookmarks: 开始保存', bookmarks.length, '条书签到 PouchDB')
  const database = await getDb()
  console.log('[PouchDB] saveBookmarks: 获取到数据库实例')
  const docs: BookmarkDoc[] = []
  
  for (const bm of bookmarks) {
    const id = PREFIX.BOOKMARK + bm.url
    console.log('[PouchDB] saveBookmarks: 检查现有文档:', id)
    const existing = await database.get(id).catch(() => null)
    
    docs.push({
      _id: id,
      type: 'bookmark',
      url: bm.url,
      title: bm.title,
      tags: bm.tags || [],
      description: bm.description,
      icon: bm.icon,
      clicks: bm.clicks || 0,
      lastClickedAt: bm.lastClickedAt,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      deleted: bm.deleted || false,
    })
  }
  
  console.log('[PouchDB] saveBookmarks: 准备 bulkDocs，文档数量:', docs.length)
  try {
    const result = await database.bulkDocs(docs)
    console.log('[PouchDB] saveBookmarks: bulkDocs 完成，结果:', result)
  } catch (err) {
    console.error('[PouchDB] saveBookmarks error:', err)
  }
}

export async function getBookmark(url: string): Promise<BookmarkDoc | null> {
  try {
    const database = await getDb()
    return await database.get(PREFIX.BOOKMARK + url)
  } catch {
    return null
  }
}

export async function getAllBookmarks(): Promise<BookmarkDoc[]> {
  try {
    const database = await getDb()
    console.log('[PouchDB] getAllBookmarks: 查询所有书签...')
    const result = await database.allDocs({
      startkey: PREFIX.BOOKMARK,
      endkey: PREFIX.BOOKMARK + '\uffff',
      include_docs: true,
    })
    console.log('[PouchDB] getAllBookmarks: 查询结果 rows 数量:', result.rows.length)
    console.log('[PouchDB] getAllBookmarks: 原始 rows:', result.rows.map((r: any) => ({ id: r.id, doc: r.doc })))
    const docs = result.rows.map((row: any) => row.doc).filter((doc: BookmarkDoc) => !doc.deleted)
    console.log('[PouchDB] getAllBookmarks: 过滤后文档数量:', docs.length)
    return docs
  } catch (err) {
    console.error('[PouchDB] getAllBookmarks error:', err)
    return []
  }
}

export async function deleteBookmark(url: string): Promise<void> {
  try {
    const database = await getDb()
    const doc = await database.get(PREFIX.BOOKMARK + url)
    await database.put({ ...doc, deleted: true, updatedAt: Date.now() })
  } catch (err) {
    console.error('[PouchDB] deleteBookmark error:', url, err)
  }
}

// ==================== 点击统计（每条 URL 一个文档）====================

export interface ClickStatDoc {
  _id: string
  _rev?: string
  type: 'click-stat'
  url: string
  count: number
  lastClickedAt: number
  clickHistory?: Array<{ timestamp: number; tag?: string }>
}

export async function recordClickToPouch(url: string, tag?: string): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CLICK + url
    const existing = await database.get(id).catch(() => null)
    
    const now = Date.now()
    const history = existing?.clickHistory || []
    history.push({ timestamp: now, tag })
    
    // 只保留最近 100 条点击记录
    if (history.length > 100) {
      history.shift()
    }
    
    const doc: ClickStatDoc = {
      _id: id,
      type: 'click-stat',
      url,
      count: (existing?.count || 0) + 1,
      lastClickedAt: now,
      clickHistory: history,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] recordClickToPouch error:', url, err)
  }
}

export async function getClickStats(): Promise<Record<string, { count: number; lastClickedAt: number }>> {
  try {
    const database = await getDb()
    const result = await database.allDocs({
      startkey: PREFIX.CLICK,
      endkey: PREFIX.CLICK + '\uffff',
      include_docs: true,
    })
    
    const stats: Record<string, { count: number; lastClickedAt: number }> = {}
    for (const row of result.rows) {
      const doc = row.doc as ClickStatDoc
      stats[doc.url] = {
        count: doc.count,
        lastClickedAt: doc.lastClickedAt,
      }
    }
    return stats
  } catch (err) {
    console.error('[PouchDB] getClickStats error:', err)
    return {}
  }
}

// ==================== 应用配置（单条文档）====================

export interface AppConfigDoc {
  _id: string
  _rev?: string
  type: 'app-config'
  tags: Array<{ id: string; name: string; displayName: string; icon: string; order: number }>
  display: {
    showFavicons: boolean
    cardStyle: 'compact' | 'comfortable'
    showDescriptions: boolean
  }
  pinnedBookmarks: string[]
  updatedAt: number
}

export async function saveAppConfigToPouch(config: Omit<AppConfigDoc, '_id' | 'type'>): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CONFIG + 'app'
    const existing = await database.get(id).catch(() => null)
    
    const doc: AppConfigDoc = {
      _id: id,
      type: 'app-config',
      tags: config.tags,
      display: config.display,
      pinnedBookmarks: config.pinnedBookmarks,
      updatedAt: Date.now(),
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveAppConfigToPouch error:', err)
  }
}

export async function loadAppConfigFromPouch(): Promise<AppConfigDoc | null> {
  try {
    const database = await getDb()
    console.log('[PouchDB] loadAppConfigFromPouch: 数据库名称:', DB_NAME)
    console.log('[PouchDB] loadAppConfigFromPouch: 查询文档 ID:', PREFIX.CONFIG + 'app')
    
    // 先列出所有文档看看
    const allDocs = await database.allDocs({ include_docs: true })
    console.log('[PouchDB] loadAppConfigFromPouch: 所有文档 IDs:', allDocs.rows.map((r: any) => r.id))
    console.log('[PouchDB] loadAppConfigFromPouch: cfg: 开头的文档:', allDocs.rows.filter((r: any) => r.id.startsWith('cfg:')).map((r: any) => ({ id: r.id, doc: r.doc })))
    
    const doc = await database.get(PREFIX.CONFIG + 'app')
    console.log('[PouchDB] loadAppConfigFromPouch: 原始文档完整内容:', JSON.stringify(doc, null, 2))
    return doc
  } catch (err) {
    console.error('[PouchDB] loadAppConfigFromPouch: 读取失败:', err)
    return null
  }
}

// ==================== WebDAV 配置（单条文档）====================

export interface WebDAVConfigDoc {
  _id: string
  _rev?: string
  type: 'webdav-config'
  url: string
  username: string
  password: string
  bookmarkPath?: string
}

export async function saveWebDAVConfigToPouch(config: Omit<WebDAVConfigDoc, '_id' | 'type'>): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CONFIG + 'webdav'
    const existing = await database.get(id).catch(() => null)
    
    const doc: WebDAVConfigDoc = {
      _id: id,
      type: 'webdav-config',
      url: config.url,
      username: config.username,
      password: config.password,
      bookmarkPath: config.bookmarkPath,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveWebDAVConfigToPouch error:', err)
  }
}

export async function loadWebDAVConfigFromPouch(): Promise<WebDAVConfigDoc | null> {
  try {
    const database = await getDb()
    return await database.get(PREFIX.CONFIG + 'webdav')
  } catch {
    return null
  }
}

// ==================== 固定书签 ====================

export async function savePinnedToPouch(urls: string[]): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.CONFIG + 'pinned'
    const existing = await database.get(id).catch(() => null)
    
    const doc = {
      _id: id,
      type: 'pinned',
      urls,
      updatedAt: Date.now(),
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] savePinnedToPouch error:', err)
  }
}

export async function loadPinnedFromPouch(): Promise<string[] | null> {
  try {
    const database = await getDb()
    const doc = await database.get(PREFIX.CONFIG + 'pinned')
    return doc.urls
  } catch {
    return null
  }
}

// ==================== 元数据（同步用）====================

export interface SyncMetaDoc {
  _id: string
  _rev?: string
  type: 'sync-meta'
  lastSyncAt: number
  deviceId: string
}

export async function saveSyncMeta(meta: Omit<SyncMetaDoc, '_id' | 'type'>): Promise<void> {
  try {
    const database = await getDb()
    const id = PREFIX.META + 'sync'
    const existing = await database.get(id).catch(() => null)
    
    const doc: SyncMetaDoc = {
      _id: id,
      type: 'sync-meta',
      lastSyncAt: meta.lastSyncAt,
      deviceId: meta.deviceId,
    }
    
    if (existing) {
      await database.put({ ...doc, _rev: existing._rev })
    } else {
      await database.put(doc)
    }
  } catch (err) {
    console.error('[PouchDB] saveSyncMeta error:', err)
  }
}

export async function loadSyncMeta(): Promise<SyncMetaDoc | null> {
  try {
    const database = await getDb()
    return await database.get(PREFIX.META + 'sync')
  } catch {
    return null
  }
}
