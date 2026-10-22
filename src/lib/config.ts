import type { WebDAVConfig, AppConfig, BookmarksStore, BookmarkEntry } from '@/types'
import { getFileContents, putFileContents, createDirectory } from '@/lib/webdav'
import {
  saveWebDAVConfigToPouch,
  saveAppConfigToPouch,
  saveBookmarks,
  getAllBookmarks,
  loadAppConfigFromPouch,
  getPouchDB,
  type BookmarkDoc,
} from '@/lib/pouchdb'
import { isRemoteStorageConfigured, scheduleAutoSync } from '@/lib/remotestorage-sync'
import { loadPinnedBookmarks, savePinnedBookmarks } from '@/lib/stats'
import { getSavedStorageCredentials } from '@/lib/remotestorage-connection'

const WEBDAV_CONFIG_KEY = 'webDAVConfig'
const APP_CONFIG_KEY = 'onenavConfig'
const BOOKMARKS_CACHE_KEY = 'onenavBookmarksCache'

// ==================== WebDAV 配置 ====================

export function loadWebDAVConfig(): WebDAVConfig | null {
  try {
    const raw = localStorage.getItem(WEBDAV_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw) as WebDAVConfig
  } catch {
    return null
  }
}

export function saveWebDAVConfig(config: WebDAVConfig): void {
  localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(config))
  saveWebDAVConfigToPouch(config) // 同步到 PouchDB
}

// ==================== 应用配置 ====================

export function loadAppConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(APP_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AppConfig
  } catch {
    return null
  }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(config))
  // 从 localStorage 读取固定书签（固定书签独立存储）
  const pinned = loadPinnedBookmarks()
  await saveAppConfigToPouch({
    tags: config.tags.map(t => ({ id: t.id, name: t.tag, displayName: t.label, icon: t.icon, order: t.order })),
    display: config.display,
    background: config.background,
    widgets: config.widgets,
    bookmarkPath: config.bookmarkPath,
    autoRefreshInterval: config.autoRefreshInterval,
    pinnedBookmarks: pinned,
    apps: config.apps,
    updatedAt: Date.now(),
  })
  console.log('[Config] saveAppConfig: 配置已保存到 localStorage 和 PouchDB, 固定书签:', pinned.length)

  // 已配置 RemoteStorage 时，保存后自动同步到服务器
  if (isRemoteStorageConfigured()) {
    const db = await getPouchDB()
    await scheduleAutoSync(db)
  }
}

export async function fetchAppConfig(wdav: WebDAVConfig): Promise<AppConfig | null> {
  try {
    const raw = await getFileContents(wdav, 'app_data/onenav/config.json')
    const config = JSON.parse(raw) as AppConfig
    await saveAppConfig(config)
    return config
  } catch {
    return null
  }
}

export async function saveAppConfigToWebDAV(wdav: WebDAVConfig, config: AppConfig): Promise<void> {
  await createDirectory(wdav, 'app_data')
  await createDirectory(wdav, 'app_data/onenav')
  await putFileContents(wdav, 'app_data/onenav/config.json', JSON.stringify(config, null, 2))
  await saveAppConfig(config)
}

// ==================== 书签数据 ====================

// 将 BookmarkDoc 转换为 BookmarkEntry（用于兼容旧格式）
function docToBookmarkEntry(doc: BookmarkDoc): BookmarkEntry {
  return {
    tags: doc.tags,
    meta: {
      url: doc.url,
      title: doc.title,
      description: doc.description,
      favicon: doc.icon,
      created: doc.createdAt,
      updated: doc.updatedAt,
    },
  }
}

// 将 BookmarkEntry 转换为 BookmarkDoc
function bookmarkEntryToDoc(url: string, entry: BookmarkEntry): Omit<BookmarkDoc, '_id' | 'type'> {
  const now = Date.now()
  return {
    url,
    title: entry.meta?.title || url,
    tags: entry.tags || [],
    description: entry.meta?.description,
    icon: entry.meta?.favicon,
    clicks: 0,
    lastClickedAt: undefined,
    createdAt: entry.meta?.created || now,
    updatedAt: entry.meta?.updated || now,
  }
}

export async function fetchBookmarks(wdav: WebDAVConfig, path: string): Promise<BookmarksStore | null> {
  try {
    console.log('[Config] fetchBookmarks: 开始从 WebDAV 获取书签:', path)
    const raw = await getFileContents(wdav, path)
    const store = JSON.parse(raw) as BookmarksStore
    console.log('[Config] fetchBookmarks: 获取到书签数量:', Object.keys(store.data).length)
    
    // 将书签保存到 PouchDB（每条一个文档）
    const bookmarks = Object.entries(store.data).map(([url, entry]) => bookmarkEntryToDoc(url, entry))
    console.log('[Config] fetchBookmarks: 准备保存到 PouchDB，书签数量:', bookmarks.length)
    await saveBookmarks(bookmarks)
    console.log('[Config] fetchBookmarks: PouchDB 保存完成')
    
    // 同时保存到 localStorage 缓存
    saveBookmarksCache(store)
    console.log('[Config] fetchBookmarks: localStorage 缓存完成')
    
    return store
  } catch (err) {
    console.error('[Config] fetchBookmarks: 失败:', err)
    return null
  }
}

export function loadBookmarksCache(): BookmarksStore | null {
  try {
    const raw = localStorage.getItem(BOOKMARKS_CACHE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as BookmarksStore
  } catch {
    return null
  }
}

export function saveBookmarksCache(store: BookmarksStore): void {
  try {
    localStorage.setItem(BOOKMARKS_CACHE_KEY, JSON.stringify(store))
  } catch {
    // localStorage 满了就忽略
  }
}

// ==================== 从 PouchDB 加载（优先）====================

export async function loadAppConfigFromPouchDB(): Promise<AppConfig | null> {
  const doc = await loadAppConfigFromPouch()
  if (!doc) return null
  
  console.log('[Config] loadAppConfigFromPouchDB: 加载配置', doc)
  console.log('[Config] loadAppConfigFromPouchDB: tags 详情:', doc.tags.map((t: any) => ({ id: t.id, name: t.name, icon: t.icon, hasIcon: 'icon' in t })))
  
  const defaults = getDefaultAppConfig()

  // 转换回 AppConfig 格式 — 从 PouchDB 文档读取真实值，仅对缺失字段回退默认值
  return {
    version: 1,
    tags: doc.tags.map((t: any) => ({ 
      id: t.id || t.name, 
      label: t.displayName, 
      tag: t.name, 
      icon: t.icon || 'LayoutGrid', 
      order: t.order 
    })),
    bookmarkPath: doc.bookmarkPath || defaults.bookmarkPath,
    display: {
      iconSize: doc.display?.iconSize ?? defaults.display.iconSize,
      iconBorderRadius: doc.display?.iconBorderRadius ?? defaults.display.iconBorderRadius,
      iconSpacing: doc.display?.iconSpacing ?? defaults.display.iconSpacing,
      showName: doc.display?.showName ?? defaults.display.showName,
      nameSize: doc.display?.nameSize ?? defaults.display.nameSize,
      maxWidth: doc.display?.maxWidth ?? defaults.display.maxWidth,
      openInNewTab: doc.display?.openInNewTab ?? defaults.display.openInNewTab,
      defaultColor: doc.display?.defaultColor ?? defaults.display.defaultColor,
    },
    background: doc.background || defaults.background,
    widgets: doc.widgets || defaults.widgets,
    autoRefreshInterval: doc.autoRefreshInterval ?? defaults.autoRefreshInterval,
    apps: doc.apps || defaults.apps,
  }
}

export async function loadBookmarksFromPouchDB(): Promise<BookmarksStore | null> {
  console.log('[Config] loadBookmarksFromPouchDB: 开始加载...')
  const docs = await getAllBookmarks()
  console.log('[Config] loadBookmarksFromPouchDB: 获取到', docs.length, '条文档')
  console.log('[Config] loadBookmarksFromPouchDB: 文档示例:', docs.slice(0, 2))
  
  if (docs.length === 0) {
    console.log('[Config] loadBookmarksFromPouchDB: 没有文档，返回 null')
    return null
  }
  
  // 转换回 BookmarksStore 格式
  const data: Record<string, BookmarkEntry> = {}
  for (const doc of docs) {
    data[doc.url] = docToBookmarkEntry(doc)
  }
  
  console.log('[Config] loadBookmarksFromPouchDB: 转换完成，共', Object.keys(data).length, '条书签')
  
  return {
    data,
    meta: {
      databaseVersion: 1,
      created: Date.now(),
      updated: Date.now(),
    },
  }
}

// ==================== 默认配置 ====================

export function getDefaultAppConfig(): AppConfig {
  return {
    version: 1,
    tags: [
      { id: 'default-onenav', label: '常用', tag: 'onenav', icon: 'LayoutGrid', order: 0 },
      { id: 'default-all', label: '全部', tag: '._all_', icon: 'Globe', order: 1 }
    ],
    bookmarkPath: 'app_data/utags/bookmarks.json',
    display: {
      iconSize: 60,
      iconBorderRadius: 16,
      iconSpacing: 27,
      showName: true,
      nameSize: 12,
      maxWidth: 1600,
      openInNewTab: true,
      defaultColor: '#1e293b',
    },
    background: {
      type: 'gradient',
      value: 'from-blue-900 via-purple-900 to-indigo-900',
      maskOpacity: 0.2,
      blur: 0,
    },
    widgets: {
      showTime: false,
      showSearchBar: false,
      showSeconds: false,
      searchEngine: 'google',
      fontSize: 70,
      fontColor: '#ffffff',
    },
    autoRefreshInterval: 60,
    apps: {},
  }
}

/**
 * 确保本地已有完整的基础数据——首次打开页面时初始化。
 *
 * 不做这一步的话，本机 PouchDB 里既没有配置文档也没有固定书签文档，
 * 各处按「文档应当存在」去读就会拿到 PouchDB 的 missing
 * （status 404 / message 'missing'），进而把整个加载流程判定为失败、
 * 给用户一个错误页。
 *
 * 这里在第一次进入时把默认配置与空的固定书签落盘，之后所有读取都能命中
 * 文档；用户没导入过数据时，书签列表就是空的，页面正常渲染而不是报错。
 */
export async function ensureInitialData(): Promise<AppConfig> {
  const local = loadAppConfig()
  if (local) return local

  try {
    const doc = await loadAppConfigFromPouchDB()
    if (doc) {
      // 补齐 localStorage 缓存，下次直接命中本地
      localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(doc))
      return doc
    }
  } catch (err) {
    console.error('[Config] ensureInitialData: 读取 PouchDB 配置失败:', err)
  }

  const defaults = getDefaultAppConfig()
  try {
    await saveAppConfig(defaults)
  } catch (err) {
    console.error('[Config] ensureInitialData: 写入默认配置失败:', err)
    // 兜底：至少保证 localStorage 里有可用配置，页面不会卡在加载态
    try {
      localStorage.setItem(APP_CONFIG_KEY, JSON.stringify(defaults))
    } catch {
      // ignore
    }
  }

  // 固定书签文档不存在时种一份空的，避免后续读取命中缺失文档
  try {
    if (loadPinnedBookmarks().length === 0) {
      savePinnedBookmarks([])
    }
  } catch (err) {
    console.error('[Config] ensureInitialData: 初始化固定书签失败:', err)
  }

  return defaults
}

/**
 * 是否已配置过至少一个同步来源（WebDAV 或 RemoteStorage）。
 *
 * 未配置时应用以「本地模式」运行：书签与设置只落在本机 PouchDB / localStorage，
 * 换设备或清理浏览器数据会丢失。此时主页应提示用户去设置里配置同步，
 * 而不是用设置向导把主页挡住。
 */
export function isSyncConfigured(): boolean {
  if (loadWebDAVConfig()) return true
  if (getSavedStorageCredentials()) return true
  // 兼容老版本的标记位（设置向导完成 RemoteStorage 接入时写入）
  return localStorage.getItem('rsConfigured') === 'true'
}
