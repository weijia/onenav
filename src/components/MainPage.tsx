import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { AppConfig, DisplayBookmark, WebDAVConfig, BookmarksStore, BookmarkEntry, AppVisibility } from '@/types'
import { loadWebDAVConfig, fetchAppConfig, fetchBookmarks, getDefaultAppConfig, saveAppConfig, saveAppConfigToWebDAV, loadAppConfigFromPouchDB, loadBookmarksFromPouchDB, ensureInitialData, isSyncConfigured } from '@/lib/config'
import { loadFavoritesBookmarks, archiveFavorites, mergeFavoritesIntoStore, mergeFavoritesData, shouldAutoArchive, type FavoritesLoadProgress } from '@/lib/favorites'
import { loadFavoritesBookmarksFromRS, archiveFavoritesOnRS } from '@/lib/favorites-remotestorage'
import { filterByTag, getMostVisitedBookmarks, isDeleted, getFaviconUrl, stringToColor } from '@/lib/bookmarks'
import { recordClick, loadClickStatsFromWebDAV, togglePinnedBookmark, loadPinnedBookmarks, loadPinnedBookmarksAsync, savePinnedBookmarks } from '@/lib/stats'
import { clearRemoteStorageLogin, getSavedStorageCredentials, getStorageCredentials, isRemoteStorageAuthError, onStatusChange } from '@/lib/remotestorage-connection'
import { deleteBookmarkFromEdit, getDeletedBookmarkUrls, getPouchDB, updateBookmarkFromEdit, upsertBookmarkEntriesFromExternal, type BookmarkEditInput } from '@/lib/pouchdb'
import { loadFromRemoteStorage } from '@/lib/remotestorage-load'
import { syncToRemoteStorage } from '@/lib/remotestorage-sync'
import { loadGiteeFavorites } from '@/lib/gitee-favorites'

import Sidebar from '@/components/Sidebar'
import BookmarkGrid from '@/components/BookmarkGrid'
import BookmarkEditDialog from '@/components/BookmarkEditDialog'
import SettingsDialog from '@/components/SettingsDialog'
import SetupWizard from '@/components/SetupWizard'
import AppCard from '@/components/apps/AppCard'
import ExternalLinkCard from '@/components/apps/ExternalLinkCard'
import { APP_MANIFEST, isAppVisible } from '@/components/apps/manifest'
import { RefreshCw, Loader2, LayoutGrid, Search, Menu, X, CloudOff, AlertTriangle } from 'lucide-react'
import { versionDisplay, buildTimeDisplay } from '@/lib/version'

type SyncStatus = 'idle' | 'pending' | 'syncing' | 'synced' | 'error'

// 应用可见性配置的并集合并：任一来源里 hidden:true 都保留，避免多端各自隐藏不同应用后相互覆盖。
export function unionAppsVisibility(
  base?: Record<string, AppVisibility>,
  incoming?: Record<string, AppVisibility>,
): Record<string, AppVisibility> {
  const out: Record<string, AppVisibility> = { ...(base || {}) }
  for (const [id, v] of Object.entries(incoming || {})) {
    if (v?.hidden) out[id] = { hidden: true }
  }
  return out
}
const PENDING_BOOKMARK_SYNC_KEY = 'onenav:pendingBookmarkSync'
const SYNC_HINT_DISMISSED_KEY = 'onenav:syncHintDismissed'

/** 取 URL 的主机名，非法 URL 时回退为原串（避免渲染配色时抛错） */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export default function MainPage() {
  const [webdavConfig, setWebdavConfig] = useState<WebDAVConfig | null>(null)
  const [appConfig, setAppConfig] = useState<AppConfig>(getDefaultAppConfig())
  const [bookmarks, setBookmarks] = useState<DisplayBookmark[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(() => {
    const hash = window.location.hash.replace('#', '')
    if (hash) return hash
    // 首次打开且没配过同步（新用户）→ 直接落在「全部书签」；
    // 已配置过的用户保持原习惯「常用书签」，不做改动。
    return isSyncConfigured() ? 'onenav' : '._all_'
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [allBookmarks, setAllBookmarks] = useState<DisplayBookmark[]>([])
  const [pinnedUrls, setPinnedUrls] = useState<string[]>([])
  const [initialized, setInitialized] = useState(false)
  const [remoteStorageNeedsLogin, setRemoteStorageNeedsLogin] = useState(false)
  const [editingBookmark, setEditingBookmark] = useState<DisplayBookmark | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() =>
    localStorage.getItem(PENDING_BOOKMARK_SYNC_KEY) === '1' ? 'pending' : 'idle'
  )
  // 是否已配置同步来源（WebDAV / RemoteStorage）。未配置时为「本地模式」，主页提示去设置里配置。
  const [syncConfigured, setSyncConfigured] = useState<boolean>(() => isSyncConfigured())
  const [syncHintDismissed, setSyncHintDismissed] = useState<boolean>(
    () => localStorage.getItem(SYNC_HINT_DISMISSED_KEY) === '1'
  )
  const processBookmarksRef = useRef<((store: BookmarksStore, config: AppConfig) => void) | undefined>(undefined)
  const favoritesDataRef = useRef<Record<string, BookmarkEntry> | null>(null)
  // 来自 Gitee 公共收藏源的外链，渲染到书签区顶部的「应用」入口，点击在新标签页打开
  const [giteeApps, setGiteeApps] = useState<{ url: string; title: string; tags: string[] }[]>([])
  const deletedBookmarkUrlsRef = useRef<Set<string>>(new Set())
  const backgroundSyncRunningRef = useRef(false)
  const pendingSyncRevisionRef = useRef(0)
  const [favProgress, setFavProgress] = useState<FavoritesLoadProgress | null>(null)

  // 合并收藏书签后渲染（收藏数据来自 favoritesDataRef）
  const renderStore = useCallback((store: BookmarksStore | null, config: AppConfig) => {
    // 本机还没有任何书签时，若外部收藏源（如 Gitee 公共收藏）已加载，
    // 也要用一个空 store 去渲染，否则这些链接一条都显示不出来。
    const hasExternal = !!favoritesDataRef.current && Object.keys(favoritesDataRef.current).length > 0
    const base = store ?? (hasExternal
      ? { data: {}, meta: { databaseVersion: 1, created: Date.now(), updated: Date.now() } }
      : null)
    if (!base) return
    const merged = favoritesDataRef.current
      ? mergeFavoritesIntoStore(base, favoritesDataRef.current, deletedBookmarkUrlsRef.current)
      : base
    processBookmarksRef.current?.(merged, config)
  }, [])

  const processBookmarks = useCallback((store: BookmarksStore, config: AppConfig) => {
    if (config.tags.length === 0) {
      setAllBookmarks([])
      setBookmarks([])
      return
    }

    let result: DisplayBookmark[]
    if (activeTag === 'onenav') {
      result = getMostVisitedBookmarks(store, 100).map(b => ({
        ...b,
        isPinned: pinnedUrls.includes(b.url),
      }))
    } else if (activeTag === '._all_' || activeTag === null) {
      result = Object.entries(store.data)
        .filter(([_, e]) => !isDeleted(e))
        .map(([url, e]) => ({
          url,
          title: e.meta.shortTitle || e.meta.title || url,
          description: e.meta.description || '',
          favicon: e.meta.favicon || getFaviconUrl(url),
          // 历史数据里可能存在非 URL 的 key（手工导入/旧格式），不能让它把整个列表渲染打穿
          color: stringToColor(safeHostname(url)),
          tags: e.tags,
          isPinned: pinnedUrls.includes(url),
        }))
    } else {
      result = filterByTag(store, activeTag).map(b => ({
        ...b,
        isPinned: pinnedUrls.includes(b.url),
      }))
    }

    result.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1
      if (!a.isPinned && b.isPinned) return 1
      return 0
    })

    setAllBookmarks(result)
    setBookmarks(result)
  }, [activeTag, pinnedUrls])

  processBookmarksRef.current = processBookmarks

  const handleRemoteStorageAuthExpired = useCallback(() => {
    console.warn('[Sync] RemoteStorage 授权已失效，需要重新登录')
    clearRemoteStorageLogin()
    setRemoteStorageNeedsLogin(true)
    setError('')
    setLoading(false)
  }, [])

  // 从所有来源加载数据并合并到 PouchDB
  const loadAllSources = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')

    try {
      const wdav = loadWebDAVConfig()
      setWebdavConfig(wdav)
      setSyncConfigured(isSyncConfigured())
      let lastStore: BookmarksStore | null = null

      // 1. 先初始化/加载本地数据（快速显示）
      //    首次打开时本机没有任何文档，这里先把默认配置与空的固定书签落盘，
      //    之后所有读取都能命中文档；没导入过数据就是空列表，不该走到报错。
      let config: AppConfig
      try {
        config = await ensureInitialData()
      } catch (err) {
        console.error('[Sync] 本地数据初始化失败，回退默认配置:', err)
        config = getDefaultAppConfig()
      }
      // 应用可见性配置跨来源并集合并（任一来源 hidden:true 都保留）
      let mergedApps = { ...(config.apps || {}) }
      const localStore = await loadBookmarksFromPouchDB().catch((err) => {
        console.error('[Sync] 本地书签读取失败，按空数据处理:', err)
        return null
      })
      deletedBookmarkUrlsRef.current = await getDeletedBookmarkUrls().catch(() => new Set<string>())
      const pinned = await loadPinnedBookmarksAsync().catch(() => [] as string[])

      // 1.5 Gitee 公共收藏源：公开仓库匿名只读，不需要 token。
      //     失败只打日志，绝不影响本地书签的正常显示。
      try {
        const gitee = await loadGiteeFavorites()
        const count = Object.keys(gitee).length
        if (count > 0) {
          favoritesDataRef.current = mergeFavoritesData(favoritesDataRef.current, gitee)
          console.log('[Gitee] 公共收藏加载完成:', count, '条')
          setGiteeApps(Object.values(gitee).map((e) => ({
            url: e.meta.url ?? '',
            title: e.meta.title ?? '',
            tags: e.tags,
          })))
        }
      } catch (err) {
        console.error('[Gitee] 公共收藏加载失败（已忽略）:', err)
      }

      setAppConfig(config)
      setPinnedUrls(pinned)
      if (localStore) {
        renderStore(localStore, config)
        lastStore = localStore
      } else {
        // 本机还没有书签，但可能已拿到 Gitee 公共收藏：
        // renderStore 内部会判断外部收藏是否存在，有则用空 store 渲染，无则保持空白。
        renderStore(null, config)
      }
      setInitialized(true)
      if (showLoading) setLoading(false)

      // 2. 从 WebDAV 加载并合并
      if (wdav) {
        try {
          await loadClickStatsFromWebDAV(wdav)

          // 2.0 收藏书签：新月份第一天自动归档，随后加载
          if (shouldAutoArchive()) {
            archiveFavorites(wdav).catch((e) => console.error('[Fav] 自动归档失败:', e))
          }
          const fav = await loadFavoritesBookmarks(wdav).catch(() => null)
          if (fav) {
            await upsertBookmarkEntriesFromExternal(fav, 'WebDAV favorites')
            favoritesDataRef.current = mergeFavoritesData(favoritesDataRef.current, fav)
          }

          const webdavConfig = await fetchAppConfig(wdav)
          if (webdavConfig) {
            mergedApps = unionAppsVisibility(mergedApps, webdavConfig.apps)
            config = { ...webdavConfig, apps: mergedApps }
            setAppConfig(config)
            if (config.pinnedBookmarks?.length) {
              setPinnedUrls(config.pinnedBookmarks)
              savePinnedBookmarks(config.pinnedBookmarks)
            }
          }
          await fetchBookmarks(wdav, config.bookmarkPath)
          // fetchBookmarks 已将 WebDAV 书签 upsert 到 PouchDB，重新从 PouchDB 加载以获取合并后的完整数据
          const storeToRender = await loadBookmarksFromPouchDB()
          if (storeToRender) { renderStore(storeToRender, config); lastStore = storeToRender }
        } catch (err) {
          console.error('[Sync] WebDAV 加载失败:', err)
        }
      }

      // 2.6 确保已加载的收藏合并进主列表渲染（WebDAV 收藏源；RS 收藏源见第 3 块）
      if (favoritesDataRef.current && lastStore) {
        renderStore(lastStore, config)
      }

      // 3. 从 RemoteStorage 加载并合并（pull only）
      const credentials = getStorageCredentials() || getSavedStorageCredentials()
      if (credentials) {
        try {
          const db = await getPouchDB()
          await loadFromRemoteStorage(db, credentials)

          // 2.5 RemoteStorage 收藏源：与主 RS 同步同时机加载，避免连接未就绪的竞态（路径 app_data/favorites）
          try {
            console.log('[FavRS] 开始从 RemoteStorage 加载收藏源（app_data/favorites）')
            if (shouldAutoArchive()) {
              await archiveFavoritesOnRS().catch((e) => {
                if (isRemoteStorageAuthError(e)) throw e
                console.error('[FavRS] 自动归档失败:', e)
              })
            }
            const rsFav = await loadFavoritesBookmarksFromRS((p) => setFavProgress(p)).catch((e) => {
              if (isRemoteStorageAuthError(e)) throw e
              return null
            })
            if (rsFav) {
              console.log(`[FavRS] 已从 RemoteStorage 读取 ${Object.keys(rsFav).length} 条收藏书签，准备写入 PouchDB`)
              const saved = await upsertBookmarkEntriesFromExternal(rsFav, 'RemoteStorage favorites')
              console.log(`[FavRS] 写入 PouchDB 完成：${saved} 条新增/更新`)
              favoritesDataRef.current = mergeFavoritesData(favoritesDataRef.current, rsFav)
            } else {
              console.log('[FavRS] 未读取到 RemoteStorage 收藏（返回为空或被忽略）')
            }
          } catch (e) {
            if (isRemoteStorageAuthError(e)) throw e
            console.error('[FavRS] 加载失败:', e)
          }

          // 重新加载以显示 RemoteStorage 的数据
          // 与本地读取同理：拉完后重读不能因为单条文档缺失就把整个加载判定为失败
          const rsConfig = await loadAppConfigFromPouchDB().catch((err) => {
            console.error('[Sync] pull 后读取配置失败:', err)
            return null
          })
          const rsStore = await loadBookmarksFromPouchDB().catch((err) => {
            console.error('[Sync] pull 后读取书签失败:', err)
            return null
          })
          deletedBookmarkUrlsRef.current = await getDeletedBookmarkUrls().catch(() => new Set<string>())
          if (rsConfig) {
            // 检查 activeTag 是否还存在
            const tagKeys = rsConfig.tags.flatMap((t: { id: string; tag: string }) => [t.id, t.tag])
            const currentTag = activeTag || 'onenav'
            if (!tagKeys.includes(currentTag) && currentTag !== '._all_' && currentTag !== 'onenav') {
              setActiveTag('onenav')
              window.location.hash = 'onenav'
            }
            mergedApps = unionAppsVisibility(mergedApps, rsConfig.apps)
            const mergedRsConfig = { ...rsConfig, apps: mergedApps }
            setAppConfig(mergedRsConfig)
            config = mergedRsConfig
          }
          if (rsStore) {
            renderStore(rsStore, config)
            lastStore = rsStore
          } else if (favoritesDataRef.current && lastStore) {
            // RS 无书签 store 但有 RS 收藏：用已有 store 触发合并渲染
            renderStore(lastStore, config)
          }

          // 4. onenav-temp 共享收件箱暂时停用，启动时不再访问该目录。
        } catch (err) {
          if (isRemoteStorageAuthError(err)) {
            handleRemoteStorageAuthExpired()
            return
          }
          console.error('[Sync] RemoteStorage 加载失败:', err)
        }
      }
    } catch (err) {
      console.error('[Sync] 加载失败:', err)
      const e = err as any
      const detail = e?.message
        ? [e.name, e.message, e?.status != null ? `status=${e.status}` : ''].filter(Boolean).join(' / ')
        : String(err)
      setError(`Failed to load data: ${detail}`)
    } finally {
      // 出错也要标记初始化完成：本地数据通常仍然可用，错误改为页内提示条，
      // 不用全屏错误页把整个主页挡掉（此前一次加载异常就会只剩下 Retry 按钮）。
      setInitialized(true)
      setLoading(false)
      // 延迟清除收藏进度，让用户看到"完成"状态
      setTimeout(() => setFavProgress(null), 2000)
    }
  }, [activeTag, handleRemoteStorageAuthExpired, renderStore])

  // 保存到所有配置的来源
  const saveToAllSources = useCallback(async (config: AppConfig) => {
    // 1. 保存到本地
    await saveAppConfig(config)

    // 2. 保存到 WebDAV
    if (webdavConfig) {
      saveAppConfigToWebDAV(webdavConfig, config).catch(() => {})
    }

    // 3. 同步到 RemoteStorage（push）
    const credentials = getStorageCredentials()
    if (credentials) {
      try {
        const db = await getPouchDB()
        await syncToRemoteStorage(db, credentials, {
          maxFileSize: 500 * 1024,
          autoMerge: true,
        })
      } catch (err) {
        if (isRemoteStorageAuthError(err)) {
          handleRemoteStorageAuthExpired()
          return
        }
        console.error('[Sync] RemoteStorage push 失败:', err)
      }
    }
  }, [handleRemoteStorageAuthExpired, webdavConfig])

  // 初始化
  useEffect(() => {
    loadAllSources()

    // 监听 RemoteStorage 连接事件
    const unlisten = onStatusChange(async (info) => {
      if (info.status === 'connected') {
        setRemoteStorageNeedsLogin(false)
        console.log('[MainPage] RemoteStorage 已连接，重新加载')
        await loadAllSources(false)
      } else if (info.status === 'error' && isRemoteStorageAuthError(info.error)) {
        handleRemoteStorageAuthExpired()
      }
    })

    return () => unlisten()
  }, [handleRemoteStorageAuthExpired, loadAllSources])

  // activeTag 变化时重新过滤
  useEffect(() => {
    const loadAndFilter = async () => {
      const store = await loadBookmarksFromPouchDB().catch(() => null)
      deletedBookmarkUrlsRef.current = await getDeletedBookmarkUrls().catch(() => new Set<string>())
      // 不判断 store 是否存在：renderStore 内部会在「本机无数据但有外部收藏源」时用空 store 渲染
      renderStore(store, appConfig)
    }
    loadAndFilter()
  }, [activeTag, appConfig, processBookmarks, renderStore])

  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await loadAllSources(false)
    } finally {
      setRefreshing(false)
    }
  }

  // 自动刷新定时器
  useEffect(() => {
    const interval = appConfig.autoRefreshInterval
    if (!interval || interval <= 0) return

    const ms = interval * 60 * 1000
    const timer = setInterval(() => {
      loadAllSources(false)
    }, ms)

    return () => clearInterval(timer)
  }, [appConfig.autoRefreshInterval, loadAllSources])

  const handleConfigSave = async (config: AppConfig) => {
    setAppConfig(config)
    await saveToAllSources(config)
  }

  const handleTagSelect = (tag: string | null) => {
    setActiveTag(tag)
    setSearchQuery('')
    window.location.hash = tag || ''
  }

  const handleTogglePin = async (url: string) => {
    togglePinnedBookmark(url)
    const newPinned = loadPinnedBookmarks()
    setPinnedUrls(newPinned)

    const updatedConfig = { ...appConfig, pinnedBookmarks: newPinned }
    setAppConfig(updatedConfig)
    await saveToAllSources(updatedConfig)
  }

  const markBookmarkSyncPending = useCallback(() => {
    pendingSyncRevisionRef.current += 1
    localStorage.setItem(PENDING_BOOKMARK_SYNC_KEY, '1')
    setSyncStatus('pending')
  }, [])

  const pushBookmarksToRemoteStorage = useCallback(async (): Promise<boolean> => {
    const credentials = getStorageCredentials() || getSavedStorageCredentials()
    if (!credentials) return false
    try {
      const db = await getPouchDB()
      await syncToRemoteStorage(db, credentials, {
        maxFileSize: 500 * 1024,
        autoMerge: true,
      })
      return true
    } catch (err) {
      if (isRemoteStorageAuthError(err)) {
        handleRemoteStorageAuthExpired()
        throw err
      }
      console.error('[Sync] 书签编辑后同步失败:', err)
      throw err
    }
  }, [handleRemoteStorageAuthExpired])

  const runBookmarkSyncInBackground = useCallback(() => {
    if (backgroundSyncRunningRef.current) return
    backgroundSyncRunningRef.current = true
    const syncRevision = pendingSyncRevisionRef.current
    setSyncStatus('syncing')

    pushBookmarksToRemoteStorage()
      .then((synced) => {
        if (synced) {
          if (pendingSyncRevisionRef.current === syncRevision) {
            localStorage.removeItem(PENDING_BOOKMARK_SYNC_KEY)
            setSyncStatus('synced')
          } else {
            localStorage.setItem(PENDING_BOOKMARK_SYNC_KEY, '1')
            setSyncStatus('pending')
          }
        } else {
          localStorage.setItem(PENDING_BOOKMARK_SYNC_KEY, '1')
          setSyncStatus('pending')
        }
      })
      .catch((err) => {
        localStorage.setItem(PENDING_BOOKMARK_SYNC_KEY, '1')
        setSyncStatus('error')
        console.error('[Sync] 后台书签同步失败:', err)
      })
      .finally(() => {
        backgroundSyncRunningRef.current = false
      })
  }, [pushBookmarksToRemoteStorage])

  const handleBookmarkEditSave = async (originalUrl: string, data: BookmarkEditInput) => {
    await updateBookmarkFromEdit(originalUrl, data)
    const store = await loadBookmarksFromPouchDB()
    deletedBookmarkUrlsRef.current = await getDeletedBookmarkUrls()
    if (store) {
      renderStore(store, appConfig)
    }
    markBookmarkSyncPending()
    runBookmarkSyncInBackground()
  }

  const handleBookmarkDelete = async (url: string) => {
    await deleteBookmarkFromEdit(url)
    deletedBookmarkUrlsRef.current.add(url)
    if (favoritesDataRef.current) {
      delete favoritesDataRef.current[url]
    }
    const store = await loadBookmarksFromPouchDB()
    deletedBookmarkUrlsRef.current = await getDeletedBookmarkUrls()
    if (store) {
      renderStore(store, appConfig)
    }
    markBookmarkSyncPending()
    runBookmarkSyncInBackground()
  }

  useEffect(() => {
    const credentials = getStorageCredentials() || getSavedStorageCredentials()
    if (initialized && syncStatus === 'pending' && credentials) {
      runBookmarkSyncInBackground()
    }
  }, [initialized, runBookmarkSyncInBackground, syncStatus])

  const handleWebDAVSetup = useCallback((config: { url: string; username: string; password: string }) => {
    setWebdavConfig(config)
    loadAllSources()
  }, [loadAllSources])

  const handleRemoteStorageSetup = useCallback(async () => {
    setRemoteStorageNeedsLogin(false)
    await loadAllSources()
  }, [loadAllSources])

  const filteredBookmarks = useMemo(() => {
    if (!searchQuery.trim()) return bookmarks
    const query = searchQuery.toLowerCase()
    return allBookmarks.filter(b =>
      b.title.toLowerCase().includes(query) ||
      b.url.toLowerCase().includes(query) ||
      b.tags.some(t => t.toLowerCase().includes(query))
    )
  }, [bookmarks, allBookmarks, searchQuery])

  // 书签区顶部展示的可见应用卡片（隐藏配置来自 appConfig.apps，未配置时默认显示）
  const visibleApps = useMemo(
    () => APP_MANIFEST.filter((a) => isAppVisible(a, appConfig.apps)),
    [appConfig.apps]
  )

  const currentTagLabel = useMemo(() => {
    if (activeTag === 'onenav') return '常用书签'
    if (activeTag === '._all_' || activeTag === null) return '全部书签'
    const tag = appConfig.tags.find((t) => t.tag === activeTag || t.id === activeTag)
    return tag?.label || activeTag || '全部书签'
  }, [activeTag, appConfig.tags])

  const syncStatusLabel = useMemo(() => {
    switch (syncStatus) {
      case 'pending':
        return '待同步'
      case 'syncing':
        return '同步中'
      case 'synced':
        return '已同步'
      case 'error':
        return '同步失败'
      default:
        return ''
    }
  }, [syncStatus])

  const syncStatusClass = useMemo(() => {
    switch (syncStatus) {
      case 'pending':
        return 'bg-amber-400/15 text-amber-100 border-amber-300/20'
      case 'syncing':
        return 'bg-blue-400/15 text-blue-100 border-blue-300/20 animate-pulse'
      case 'synced':
        return 'bg-emerald-400/15 text-emerald-100 border-emerald-300/20'
      case 'error':
        return 'bg-red-400/15 text-red-100 border-red-300/20'
      default:
        return ''
    }
  }, [syncStatus])

  const renderBackground = () => {
    const { background } = appConfig
    if (background.type === 'gradient') {
      return <div className={`fixed inset-0 bg-gradient-to-br ${background.value}`} />
    }
    if (background.type === 'image') {
      return (
        <div className="fixed inset-0">
          <img src={background.value} alt="" className="w-full h-full object-cover" style={{ filter: `blur(${background.blur}px)` }} />
          <div className="absolute inset-0 bg-black" style={{ opacity: background.maskOpacity }} />
        </div>
      )
    }
    return <div className="fixed inset-0" style={{ backgroundColor: background.value }} />
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-white/60 animate-spin mx-auto mb-4" />
          <p className="text-white/60">Loading...</p>
        </div>
        {/* 浮动加载状态 - 页面加载时也可见 */}
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <span className="rounded-full border border-blue-300/20 bg-blue-400/15 px-3 py-1.5 text-xs text-blue-100 backdrop-blur-sm shadow-lg animate-pulse">
            加载中...
          </span>
        </div>
      </div>
    )
  }

  if (remoteStorageNeedsLogin) {
    return (
      <SetupWizard
        initialMode="remotestorage"
        message="RemoteStorage 登录已失效，或当前 token 没有 app_data/favorites 访问权限。请重新登录 RemoteStorage 以授权 app_data。"
        onWebDAVSetup={handleWebDAVSetup}
        onRemoteStorageSetup={handleRemoteStorageSetup}
      />
    )
  }

  // 初始化未完成只显示加载态：此前这里渲染的是 SetupWizard，会让用户（尤其是未配置同步的新用户）
  // 每次进入主页前先闪一下设置向导。加 !error 保证加载失败时仍能走到下面的错误页。
  if (!initialized && !error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900">
        <Loader2 className="w-6 h-6 text-white/60 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen relative overflow-hidden">
      {renderBackground()}
      <Sidebar tags={appConfig.tags} activeTag={activeTag} onTagSelect={handleTagSelect} onSettingsClick={() => setSettingsOpen(true)} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="relative z-10 min-h-screen flex flex-col overflow-x-hidden transition-all duration-200" style={{ marginLeft: sidebarOpen ? '60px' : '0', width: sidebarOpen ? 'calc(100% - 60px)' : '100%' }}>
        <div className="flex items-center justify-between px-4 sm:px-6 py-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition-all" title="Toggle Sidebar">
              {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <LayoutGrid className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-sm">OneNav</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleRefresh} disabled={refreshing} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition-all" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-4">
          {/* 加载异常提示：不再用全屏错误页挡住主页，本地数据照常可用，可重试 */}
          {error && (
            <div className="w-full mb-5 flex items-start gap-3 rounded-xl border border-red-300/25 bg-red-400/10 px-4 py-3" style={{ maxWidth: `${appConfig.display.maxWidth}px` }}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-200/80" />
              <p className="flex-1 text-xs leading-relaxed text-red-100/80 break-all">
                {error} —— 已加载的本地数据仍可正常使用。
              </p>
              <button
                onClick={handleRefresh}
                className="shrink-0 rounded-lg border border-red-200/30 bg-white/5 px-2.5 py-1.5 text-xs text-red-100 hover:bg-white/10 transition-colors"
              >
                Retry
              </button>
              <button
                onClick={() => setError('')}
                className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-red-100/50 hover:text-red-100 hover:bg-white/10 transition-colors"
                title="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {bookmarks.length > 0 && (
            <div className="w-full max-w-md mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input type="text" placeholder="搜索书签..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full h-10 pl-10 pr-4 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 focus:outline-none focus:border-white/40" />
              </div>
            </div>
          )}
          <div className="w-full overflow-visible" style={{ maxWidth: `${appConfig.display.maxWidth}px` }}>
            {/* 应用入口：默认显示在书签区顶部，可于设置中隐藏；点击跳转到该应用的独立页面。
                来自 Gitee 公共收藏的外链（ favorites.json ）也渲染在此，作为可一键打开的「应用」。 */}
            {(visibleApps.length > 0 || giteeApps.length > 0) && !searchQuery.trim() && (
              <div className="mb-7">
                <p className="text-xs uppercase tracking-[0.18em] text-white/35 mb-3 px-2">应用</p>
                <div className="flex flex-wrap gap-4 justify-center">
                  {visibleApps.map((a) => (
                    <AppCard
                      key={a.id}
                      app={a}
                      iconSize={appConfig.display.iconSize}
                      borderRadius={appConfig.display.iconBorderRadius}
                      nameSize={appConfig.display.nameSize}
                    />
                  ))}
                  {giteeApps.map((link) => (
                    <ExternalLinkCard
                      key={link.url}
                      url={link.url}
                      title={link.title}
                      iconSize={appConfig.display.iconSize}
                      borderRadius={appConfig.display.iconBorderRadius}
                      nameSize={appConfig.display.nameSize}
                    />
                  ))}
                </div>
              </div>
            )}
            {/* 本地模式同步提示：只针对还没配过 WebDAV / RemoteStorage 的用户 */}
            {!syncConfigured && !syncHintDismissed && (
              <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-300/25 bg-amber-400/10 px-4 py-3">
                <CloudOff className="w-4 h-4 mt-0.5 shrink-0 text-amber-200/80" />
                <p className="flex-1 text-xs leading-relaxed text-amber-100/80">
                  尚未配置同步，书签与设置仅保存在本机 —— 换设备或清理浏览器数据会丢失。
                </p>
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="shrink-0 rounded-lg border border-amber-200/30 bg-white/5 px-2.5 py-1.5 text-xs text-amber-100 hover:bg-white/10 transition-colors"
                >
                  去设置
                </button>
                <button
                  onClick={() => {
                    localStorage.setItem(SYNC_HINT_DISMISSED_KEY, '1')
                    setSyncHintDismissed(true)
                  }}
                  className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-amber-100/50 hover:text-amber-100 hover:bg-white/10 transition-colors"
                  title="不再提示"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <div className="mb-4 flex items-center justify-between px-2">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">当前标签</p>
                <h2 className="mt-1 text-lg font-medium text-white/85">{currentTagLabel}</h2>
              </div>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/45">
                {filteredBookmarks.length} 个书签
              </span>
            </div>
            <BookmarkGrid bookmarks={filteredBookmarks} iconSize={appConfig.display.iconSize} borderRadius={appConfig.display.iconBorderRadius} spacing={appConfig.display.iconSpacing} showName={appConfig.display.showName} nameSize={appConfig.display.nameSize} maxWidth={appConfig.display.maxWidth} openInNewTab={appConfig.display.openInNewTab} onItemClick={(bookmark) => recordClick(bookmark, webdavConfig || undefined)} onTogglePin={handleTogglePin} onEditBookmark={setEditingBookmark} />
            {/* 空状态：刚初始化完还没导入任何数据时给出明确引导，而不是留一片空白 */}
            {allBookmarks.length === 0 && !searchQuery.trim() && (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-6 py-10 text-center">
                <p className="text-white/60 text-sm mb-1">还没有书签</p>
                <p className="text-white/35 text-xs leading-relaxed">
                  在设置里配置 WebDAV 或 RemoteStorage 即可同步已有书签，<br />
                  之后添加的书签会自动保存在本机。
                </p>
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="mt-4 rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 transition-colors"
                >
                  去设置
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="text-center pb-4 text-white/20 text-xs flex items-center justify-center gap-2">
          <span>{versionDisplay}</span>
          <span>·</span>
          <span>{buildTimeDisplay}</span>
        </div>
      </main>
      {/* 浮动收藏加载进度 */}
      {favProgress && favProgress.phase !== 'done' && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 z-50 transition-all duration-300">
          <div className="rounded-full border border-cyan-300/20 bg-cyan-400/15 px-4 py-2 text-xs text-cyan-100 backdrop-blur-sm shadow-lg flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{favProgress.message || '正在加载收藏书签...'}</span>
            {favProgress.totalMonths != null && favProgress.processedMonths != null && favProgress.totalMonths > 0 && (
              <span className="text-cyan-300/70">
                {favProgress.processedMonths}/{favProgress.totalMonths}
                {favProgress.loadedBookmarks != null && ` · ${favProgress.loadedBookmarks} 条`}
              </span>
            )}
          </div>
        </div>
      )}
      {favProgress && favProgress.phase === 'done' && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 z-50 transition-all duration-300">
          <div className="rounded-full border border-green-300/20 bg-green-400/15 px-4 py-2 text-xs text-green-100 backdrop-blur-sm shadow-lg flex items-center gap-2">
            <span>{favProgress.message}</span>
          </div>
        </div>
      )}
      {/* 浮动同步状态 - 始终可见 */}
      {syncStatusLabel && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300">
          <span className={`rounded-full border px-3 py-1.5 text-xs backdrop-blur-sm shadow-lg ${syncStatusClass}`}>
            {syncStatusLabel}
          </span>
        </div>
      )}
      <BookmarkEditDialog
        open={!!editingBookmark}
        bookmark={editingBookmark}
        onOpenChange={(open) => {
          if (!open) setEditingBookmark(null)
        }}
        onSave={handleBookmarkEditSave}
        onDelete={handleBookmarkDelete}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (!open) {
            // 关闭设置里可能刚配上 WebDAV / RemoteStorage：让同步提示即时消失
            const next = isSyncConfigured()
            setSyncConfigured(next)
            // 从「未配置」变「已配置」时重新拉一次数据，让新配置无需刷新页面就生效
            if (!syncConfigured && next) loadAllSources(false)
          }
        }}
        config={appConfig}
        onConfigSave={handleConfigSave}
      />
    </div>
  )
}
