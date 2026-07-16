import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { AppConfig, DisplayBookmark, WebDAVConfig, BookmarksStore, BookmarkEntry } from '@/types'
import { loadWebDAVConfig, loadAppConfig, fetchAppConfig, fetchBookmarks, getDefaultAppConfig, saveAppConfig, saveAppConfigToWebDAV, loadAppConfigFromPouchDB, loadBookmarksFromPouchDB } from '@/lib/config'
import { loadFavoritesBookmarks, archiveFavorites, mergeFavoritesIntoStore, mergeFavoritesData, shouldAutoArchive } from '@/lib/favorites'
import { loadFavoritesBookmarksFromRS, archiveFavoritesOnRS } from '@/lib/favorites-remotestorage'
import { filterByTag, getMostVisitedBookmarks, isDeleted, getFaviconUrl, stringToColor } from '@/lib/bookmarks'
import { recordClick, loadClickStatsFromWebDAV, togglePinnedBookmark, loadPinnedBookmarks, loadPinnedBookmarksAsync, savePinnedBookmarks } from '@/lib/stats'
import { clearRemoteStorageLogin, getSavedStorageCredentials, getStorageCredentials, isRemoteStorageAuthError, onStatusChange } from '@/lib/remotestorage-connection'
import { getPouchDB } from '@/lib/pouchdb'
import { loadFromRemoteStorage } from '@/lib/remotestorage-load'
import { syncToRemoteStorage } from '@/lib/remotestorage-sync'

import Sidebar from '@/components/Sidebar'
import BookmarkGrid from '@/components/BookmarkGrid'
import SettingsDialog from '@/components/SettingsDialog'
import SetupWizard from '@/components/SetupWizard'
import { RefreshCw, Loader2, LayoutGrid, Search, Menu, X } from 'lucide-react'
import { versionDisplay, buildTimeDisplay } from '@/lib/version'

export default function MainPage() {
  const [webdavConfig, setWebdavConfig] = useState<WebDAVConfig | null>(null)
  const [appConfig, setAppConfig] = useState<AppConfig>(getDefaultAppConfig())
  const [bookmarks, setBookmarks] = useState<DisplayBookmark[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(() => {
    return window.location.hash.replace('#', '') || 'onenav'
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
  const processBookmarksRef = useRef<((store: BookmarksStore, config: AppConfig) => void) | undefined>(undefined)
  const favoritesDataRef = useRef<Record<string, BookmarkEntry> | null>(null)

  // 合并收藏书签后渲染（收藏数据来自 favoritesDataRef）
  const renderStore = useCallback((store: BookmarksStore | null, config: AppConfig) => {
    if (!store) return
    const merged = favoritesDataRef.current
      ? mergeFavoritesIntoStore(store, favoritesDataRef.current)
      : store
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
          color: stringToColor(new URL(url).hostname),
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
      let lastStore: BookmarksStore | null = null

      // 1. 先从本地加载缓存（快速显示）
      let config = loadAppConfig() || await loadAppConfigFromPouchDB() || getDefaultAppConfig()
      const localStore = await loadBookmarksFromPouchDB()
      const pinned = await loadPinnedBookmarksAsync()

      setAppConfig(config)
      setPinnedUrls(pinned)
      if (localStore) {
        renderStore(localStore, config)
        lastStore = localStore
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
          if (fav) favoritesDataRef.current = mergeFavoritesData(favoritesDataRef.current, fav)

          const webdavConfig = await fetchAppConfig(wdav)
          if (webdavConfig) {
            config = webdavConfig
            setAppConfig(config)
            if (config.pinnedBookmarks?.length) {
              setPinnedUrls(config.pinnedBookmarks)
              savePinnedBookmarks(config.pinnedBookmarks)
            }
          }
          const webdavStore = await fetchBookmarks(wdav, config.bookmarkPath)
          // 渲染：优先 webdav，否则回退本地（保证收藏合并生效）
          const storeToRender = webdavStore || (await loadBookmarksFromPouchDB())
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
            if (shouldAutoArchive()) {
              await archiveFavoritesOnRS().catch((e) => {
                if (isRemoteStorageAuthError(e)) throw e
                console.error('[FavRS] 自动归档失败:', e)
              })
            }
            const rsFav = await loadFavoritesBookmarksFromRS().catch((e) => {
              if (isRemoteStorageAuthError(e)) throw e
              return null
            })
            if (rsFav) favoritesDataRef.current = mergeFavoritesData(favoritesDataRef.current, rsFav)
          } catch (e) {
            if (isRemoteStorageAuthError(e)) throw e
            console.error('[FavRS] 加载失败:', e)
          }

          // 重新加载以显示 RemoteStorage 的数据
          const rsConfig = await loadAppConfigFromPouchDB()
          const rsStore = await loadBookmarksFromPouchDB()
          if (rsConfig) {
            // 检查 activeTag 是否还存在
            const tagKeys = rsConfig.tags.flatMap((t: { id: string; tag: string }) => [t.id, t.tag])
            const currentTag = activeTag || 'onenav'
            if (!tagKeys.includes(currentTag) && currentTag !== '._all_' && currentTag !== 'onenav') {
              setActiveTag('onenav')
              window.location.hash = 'onenav'
            }
            setAppConfig(rsConfig)
            config = rsConfig
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
      setError(`Failed to load data: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setLoading(false)
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
      const store = await loadBookmarksFromPouchDB()
      if (store) renderStore(store, appConfig)
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

  if (!initialized) {
    return <SetupWizard onWebDAVSetup={handleWebDAVSetup} onRemoteStorageSetup={handleRemoteStorageSetup} />
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 p-4">
        <div className="max-w-md text-center">
          <p className="text-red-300 mb-4">{error}</p>
          <button onClick={handleRefresh} className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg border border-white/20 transition-colors">
            Retry
          </button>
        </div>
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
          <button onClick={handleRefresh} disabled={refreshing} className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition-all" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-4">
          {bookmarks.length > 0 && (
            <div className="w-full max-w-md mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input type="text" placeholder="搜索书签..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full h-10 pl-10 pr-4 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 focus:outline-none focus:border-white/40" />
              </div>
            </div>
          )}
          <div className="w-full overflow-visible">
            <BookmarkGrid bookmarks={filteredBookmarks} iconSize={appConfig.display.iconSize} borderRadius={appConfig.display.iconBorderRadius} spacing={appConfig.display.iconSpacing} showName={appConfig.display.showName} nameSize={appConfig.display.nameSize} maxWidth={appConfig.display.maxWidth} openInNewTab={appConfig.display.openInNewTab} onItemClick={(bookmark) => recordClick(bookmark, webdavConfig || undefined)} onTogglePin={handleTogglePin} />
          </div>
        </div>

        <div className="text-center pb-4 text-white/20 text-xs flex items-center justify-center gap-2">
          <span>{versionDisplay}</span>
          <span>·</span>
          <span>{buildTimeDisplay}</span>
        </div>
      </main>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} config={appConfig} onConfigSave={handleConfigSave} />
    </div>
  )
}
