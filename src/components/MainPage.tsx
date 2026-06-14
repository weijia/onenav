import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { AppConfig, DisplayBookmark, WebDAVConfig, BookmarksStore } from '@/types'
import { loadWebDAVConfig, loadAppConfig, fetchAppConfig, fetchBookmarks, getDefaultAppConfig, saveAppConfig, saveAppConfigToWebDAV, loadAppConfigFromPouchDB, loadBookmarksFromPouchDB } from '@/lib/config'
import { filterByTag, getMostVisitedBookmarks, isDeleted, getFaviconUrl, stringToColor } from '@/lib/bookmarks'
import { recordClick, loadClickStatsFromWebDAV, togglePinnedBookmark, loadPinnedBookmarks, loadPinnedBookmarksAsync, savePinnedBookmarks } from '@/lib/stats'
import { getStorageCredentials, onStatusChange } from '@/lib/remotestorage-connection'
import { getPouchDB } from '@/lib/pouchdb'
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
  const cachedStoreRef = useRef(false)
  const processBookmarksRef = useRef<((store: BookmarksStore, config: AppConfig) => void) | undefined>(undefined)

  const loadAllData = useCallback(async (wdav: WebDAVConfig, showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')

    try {
      // Load click stats from WebDAV and merge with local
      await loadClickStatsFromWebDAV(wdav)

      // Load app config: WebDAV > PouchDB > localStorage > default
      let config = await fetchAppConfig(wdav)
      if (!config) {
        config = await loadAppConfigFromPouchDB()
      }
      if (!config) {
        config = loadAppConfig()
      }
      if (!config) {
        config = getDefaultAppConfig()
      }
      setAppConfig(config)

      // 从配置文件恢复固定书签列表
      if (config.pinnedBookmarks && config.pinnedBookmarks.length > 0) {
        setPinnedUrls(config.pinnedBookmarks)
        savePinnedBookmarks(config.pinnedBookmarks)
      }

      // 从 PouchDB 加载，立即显示
      const cachedStore = await loadBookmarksFromPouchDB()
      if (cachedStore) {
        cachedStoreRef.current = true
        processBookmarksRef.current?.(cachedStore, config)
        if (showLoading) setLoading(false)
      }

      // 从 WebDAV 加载最新数据，更新缓存和显示
      const store = await fetchBookmarks(wdav, config.bookmarkPath)
      if (store) {
        processBookmarksRef.current?.(store, config)
      }
    } catch (err) {
      // WebDAV 加载失败，如果已有缓存数据就不报错
      if (!cachedStoreRef.current) {
        setError(`Failed to load data: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const processBookmarks = useCallback((store: BookmarksStore, config: AppConfig) => {
    console.log('[MainPage] processBookmarks: 开始处理书签', { storeKeys: Object.keys(store.data).length, configTags: config.tags.length })
    console.log('[MainPage] processBookmarks: 当前 pinnedUrls:', pinnedUrls.length, pinnedUrls)
    if (config.tags.length === 0) {
      console.log('[MainPage] processBookmarks: 没有标签，清空书签')
      setAllBookmarks([])
      setBookmarks([])
      return
    }

    let result: DisplayBookmark[]
    if (activeTag === 'onenav') {
      console.log('[MainPage] processBookmarks: 常用标签模式')
      result = getMostVisitedBookmarks(store, 100).map(b => ({
        ...b,
        isPinned: pinnedUrls.includes(b.url),
      }))
    } else if (activeTag === '._all_' || activeTag === null) {
      console.log('[MainPage] processBookmarks: 全部标签模式，数据条目:', Object.keys(store.data).length)
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
      console.log('[MainPage] processBookmarks: 特定标签模式:', activeTag)
      result = filterByTag(store, activeTag).map(b => ({
        ...b,
        isPinned: pinnedUrls.includes(b.url),
      }))
    }

    const pinnedCount = result.filter(b => b.isPinned).length
    console.log('[MainPage] processBookmarks: 处理结果数量:', result.length, '其中固定:', pinnedCount)

    // 按固定状态排序：固定的在前
    result.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1
      if (!a.isPinned && b.isPinned) return 1
      return 0
    })

    setAllBookmarks(result)
    setBookmarks(result)
  }, [activeTag, pinnedUrls])

  // 保持 ref 与最新 processBookmarks 同步
  processBookmarksRef.current = processBookmarks

  // 当固定书签变化时，重新处理书签排序
  useEffect(() => {
    if (!initialized) return
    // 从 PouchDB 或 WebDAV 重新加载书签并处理
    const reprocess = async () => {
      let store: BookmarksStore | null = null
      if (webdavConfig) {
        store = await fetchBookmarks(webdavConfig, appConfig.bookmarkPath)
      } else {
        store = await loadBookmarksFromPouchDB()
      }
      if (store) {
        processBookmarksRef.current?.(store, appConfig)
      }
    }
    reprocess()
  }, [pinnedUrls, initialized, webdavConfig, appConfig])

  // Filter bookmarks based on search query
  const filteredBookmarks = useMemo(() => {
    if (!searchQuery.trim()) {
      return bookmarks
    }
    const query = searchQuery.toLowerCase()
    return allBookmarks.filter(b =>
      b.title.toLowerCase().includes(query) ||
      b.url.toLowerCase().includes(query) ||
      b.tags.some(t => t.toLowerCase().includes(query))
    )
  }, [bookmarks, allBookmarks, searchQuery, activeTag])

  // 从 RemoteStorage 同步数据到 PouchDB 并刷新页面
  const syncFromRemoteStorage = useCallback(async () => {
    try {
      const localConfig = loadAppConfig()
      if (localConfig) {
        console.log('[Sync] 将 localStorage 配置写入 PouchDB')
        await saveAppConfig(localConfig)
      }
      
      const db = await getPouchDB()
      const credentials = getStorageCredentials()
      if (!credentials) {
        console.warn('[Sync] 没有 RemoteStorage 凭证，跳过同步')
        return
      }
      
      await syncToRemoteStorage(db, credentials, {
        maxFileSize: 500 * 1024,
        autoMerge: true,
      })
      console.log('[Sync] 同步完成，刷新数据')
      
      // 同步完成后重新从 PouchDB 加载数据
      const updatedConfig = await loadAppConfigFromPouchDB()
      const updatedStore = await loadBookmarksFromPouchDB()
      const updatedPinned = await loadPinnedBookmarksAsync()
      
      if (updatedConfig) {
        // 检查当前 activeTag 是否在新配置的标签列表中
        const tagIds = updatedConfig.tags.map((t: { id: string }) => t.id)
        const currentTag = activeTag || 'onenav'
        if (!tagIds.includes(currentTag) && currentTag !== '._all_' && currentTag !== 'onenav') {
          console.log('[Sync] activeTag', currentTag, '不在新配置中，重置为 onenav')
          setActiveTag('onenav')
          window.location.hash = 'onenav'
        }
        setAppConfig(updatedConfig)
      }
      if (updatedStore) {
        processBookmarksRef.current?.(updatedStore, updatedConfig || appConfig || getDefaultAppConfig())
      }
      if (updatedPinned.length > 0) {
        setPinnedUrls(updatedPinned)
      }
    } catch (err) {
      console.error('[Sync] 同步失败:', err)
    }
  }, [appConfig])

  useEffect(() => {
    console.log('[MainPage] mounted, loading:', loading, 'initialized:', initialized)
    
    const init = async () => {
      try {
        console.log('[Init] 开始初始化...')
        const wdav = loadWebDAVConfig()
        const hasRSToken = window.location.hash.includes('access_token')
        console.log('[Init] WebDAV config:', wdav, 'hasRSToken:', hasRSToken)
        if (wdav && !hasRSToken) {
          console.log('[Init] 使用 WebDAV 配置')
          setWebdavConfig(wdav)
          setInitialized(true)
          loadAllData(wdav)
        } else {
          // 没有 WebDAV 配置，或正在添加 RemoteStorage（URL 中有 access_token）
          if (hasRSToken) {
            console.log('[Init] 检测到 RemoteStorage OAuth 回调，切换到 RemoteStorage 模式')
          } else {
            console.log('[Init] RemoteStorage 模式，先加载缓存再同步')
          }
          
          // 1. 先从 PouchDB/localStorage 加载缓存（快速显示）
          console.log('[Init] 开始加载配置...')
          const cachedConfig = loadAppConfig() || await loadAppConfigFromPouchDB()
          console.log('[Init] cachedConfig:', cachedConfig)
          
          console.log('[Init] 开始加载书签...')
          const cachedStore = await loadBookmarksFromPouchDB()
          console.log('[Init] cachedStore:', cachedStore ? { keys: Object.keys(cachedStore.data).length } : null)
          
          console.log('[Init] 开始加载固定书签...')
          const pinned = await loadPinnedBookmarksAsync()
          console.log('[Init] 固定书签数量:', pinned.length)
          setPinnedUrls(pinned)
          
          if (cachedConfig) {
            console.log('[Init] 设置配置')
            setAppConfig(cachedConfig)
          }
          if (cachedStore) {
            console.log('[Init] 处理书签数据')
            processBookmarksRef.current?.(cachedStore, cachedConfig || getDefaultAppConfig())
          } else {
            console.log('[Init] 没有书签数据')
          }
          
          setInitialized(true)
          setLoading(false)
          
          // 2. 后台从 RemoteStorage 同步最新数据
          const credentials = getStorageCredentials()
          if (credentials) {
            console.log('[Init] 开始后台同步 RemoteStorage...')
            await syncFromRemoteStorage()
          } else {
            // OAuth 回调后 connected 事件可能稍后触发，监听 connected 事件
            console.log('[Init] RemoteStorage 未连接，监听 connected 事件...')
            const unlisten = onStatusChange(async (info) => {
              if (info.status === 'connected') {
                console.log('[Init] RemoteStorage 已连接，开始同步')
                unlisten()
                const creds = getStorageCredentials()
                if (creds) {
                  await syncFromRemoteStorage()
                }
              }
            })
          }
        }
      } catch (err) {
        console.error('[Init] 初始化错误:', err)
        setLoading(false)
      }
    }
    init()
  }, [loadAllData])

  // Re-process bookmarks when active tag changes
  // 当 activeTag 改变时，重新处理书签（支持 WebDAV 和 PouchDB 模式）
  useEffect(() => {
    const loadAndFilter = async () => {
      let store: BookmarksStore | null = null
      
      if (webdavConfig) {
        // WebDAV 模式
        store = await fetchBookmarks(webdavConfig, appConfig.bookmarkPath)
      } else {
        // PouchDB 模式
        store = await loadBookmarksFromPouchDB()
      }
      
      if (store) {
        processBookmarks(store, appConfig)
      }
    }

    loadAndFilter()
  }, [activeTag, webdavConfig, appConfig, processBookmarks])

  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      if (webdavConfig) {
        await loadAllData(webdavConfig, false)
      } else {
        // RemoteStorage / PouchDB 模式：从 PouchDB 重新加载
        const updatedConfig = await loadAppConfigFromPouchDB() || loadAppConfig() || getDefaultAppConfig()
        setAppConfig(updatedConfig)
        const store = await loadBookmarksFromPouchDB()
        if (store) {
          processBookmarksRef.current?.(store, updatedConfig)
        }
        const pinned = await loadPinnedBookmarksAsync()
        if (pinned.length > 0) {
          setPinnedUrls(pinned)
        }
      }
    } finally {
      setRefreshing(false)
    }
  }

  // 自动刷新定时器
  useEffect(() => {
    const interval = appConfig.autoRefreshInterval
    if (!interval || interval <= 0 || !webdavConfig) return

    const ms = interval * 60 * 1000
    console.log('[MainPage] 自动刷新间隔:', interval, '分钟')
    const timer = setInterval(() => {
      console.log('[MainPage] 自动刷新...')
      loadAllData(webdavConfig, false)
    }, ms)

    return () => clearInterval(timer)
  }, [appConfig.autoRefreshInterval, webdavConfig, loadAllData])

  const handleConfigSave = async (config: AppConfig) => {
    setAppConfig(config)
    await saveAppConfig(config)
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

    // 同步到配置文件（localStorage + WebDAV）
    const updatedConfig = { ...appConfig, pinnedBookmarks: newPinned }
    setAppConfig(updatedConfig)
    await saveAppConfig(updatedConfig)
    if (webdavConfig) {
      saveAppConfigToWebDAV(webdavConfig, updatedConfig).catch(() => {
        // WebDAV 保存失败不影响本地使用
      })
      fetchBookmarks(webdavConfig, appConfig.bookmarkPath).then(store => {
        if (store) {
          processBookmarks(store, updatedConfig)
        }
      })
    }
  }

  // 向导回调：WebDAV 配置完成
  const handleWebDAVSetup = useCallback((config: { url: string; username: string; password: string }) => {
    const wdav: WebDAVConfig = config
    setWebdavConfig(wdav)
    setInitialized(true)
    loadAllData(wdav)
  }, [loadAllData])

  // 向导回调：RemoteStorage 配置完成
  const handleRemoteStorageSetup = useCallback(async (_credentials: { href: string; token: string }) => {
    console.log('[MainPage] handleRemoteStorageSetup: RemoteStorage 配置完成，从 PouchDB 加载数据')
    // RemoteStorage 数据已通过 SetupWizard 同步到 PouchDB，从 PouchDB 加载
    const cachedConfig = loadAppConfig() || await loadAppConfigFromPouchDB() || getDefaultAppConfig()
    setAppConfig(cachedConfig)
    
    const cachedStore = await loadBookmarksFromPouchDB()
    if (cachedStore) {
      console.log('[MainPage] handleRemoteStorageSetup: 加载到书签:', Object.keys(cachedStore.data).length)
      processBookmarksRef.current?.(cachedStore, cachedConfig)
    } else {
      console.warn('[MainPage] handleRemoteStorageSetup: PouchDB 中没有书签数据')
    }
    
    const pinned = await loadPinnedBookmarksAsync()
    if (pinned.length > 0) {
      console.log('[MainPage] handleRemoteStorageSetup: 加载到固定书签:', pinned.length)
      setPinnedUrls(pinned)
    }
    
    setInitialized(true)
    setLoading(false)
  }, [])

  // Render background
  const renderBackground = () => {
    const { background } = appConfig

    if (background.type === 'gradient') {
      return (
        <div className={`fixed inset-0 bg-gradient-to-br ${background.value}`} />
      )
    }

    if (background.type === 'image') {
      return (
        <div className="fixed inset-0">
          <img
            src={background.value}
            alt=""
            className="w-full h-full object-cover"
            style={{ filter: `blur(${background.blur}px)` }}
          />
          <div
            className="absolute inset-0 bg-black"
            style={{ opacity: background.maskOpacity }}
          />
        </div>
      )
    }

    // Solid color
    return (
      <div className="fixed inset-0" style={{ backgroundColor: background.value }} />
    )
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

  // 未初始化：显示初始化向导
  if (!initialized) {
    return <SetupWizard onWebDAVSetup={handleWebDAVSetup} onRemoteStorageSetup={handleRemoteStorageSetup} />
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 p-4">
        <div className="max-w-md text-center">
          <p className="text-red-300 mb-4">{error}</p>
          <button
            onClick={handleRefresh}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg border border-white/20 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background */}
      {renderBackground()}

      {/* Sidebar */}
      <Sidebar
        tags={appConfig.tags}
        activeTag={activeTag}
        onTagSelect={handleTagSelect}
        onSettingsClick={() => setSettingsOpen(true)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main content */}
      <main className="relative z-10 min-h-screen flex flex-col overflow-x-hidden transition-all duration-200" style={{ marginLeft: sidebarOpen ? '60px' : '0', width: sidebarOpen ? 'calc(100% - 60px)' : '100%' }}>
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition-all"
              title="Toggle Sidebar"
            >
              {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <LayoutGrid className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-sm">OneNav</span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition-all"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Center content */}
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          {/* Search bar */}
          {bookmarks.length > 0 && (
            <div className="w-full max-w-md mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input
                  type="text"
                  placeholder="搜索书签..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-10 pl-10 pr-4 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/40 focus:outline-none focus:border-white/40"
                />
              </div>
            </div>
          )}
          {/* Bookmark grid */}
          <div className="w-full overflow-visible">
            <BookmarkGrid
              bookmarks={filteredBookmarks}
              iconSize={appConfig.display.iconSize}
              borderRadius={appConfig.display.iconBorderRadius}
              spacing={appConfig.display.iconSpacing}
              showName={appConfig.display.showName}
              nameSize={appConfig.display.nameSize}
              maxWidth={appConfig.display.maxWidth}
              openInNewTab={appConfig.display.openInNewTab}
              onItemClick={(bookmark) => recordClick(bookmark, webdavConfig || undefined)}
              onTogglePin={handleTogglePin}
            />
          </div>
        </div>

        {/* Version info */}
        <div className="text-center pb-4 text-white/20 text-xs flex items-center justify-center gap-2">
          <span>{versionDisplay}</span>
          <span>·</span>
          <span>{buildTimeDisplay}</span>
          {(() => {
            const pathname = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '')
            const segments = pathname.split('/').filter(Boolean)
            const currentDir = segments[segments.length - 1] || ''
            if (currentDir === 'latest') {
              return (
                <>
                  <span>·</span>
                  <a href="../release/index.html" className="hover:text-white/40 transition-colors">切换到正式版</a>
                </>
              )
            }
            if (currentDir === 'release' || /^\d{8}$/.test(currentDir)) {
              return (
                <>
                  <span>·</span>
                  <a href="../latest/index.html" className="hover:text-white/40 transition-colors">切换到最新版</a>
                </>
              )
            }
            return null
          })()}
        </div>
      </main>

      {/* Settings dialog */}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        config={appConfig}
        onConfigSave={handleConfigSave}
      />
    </div>
  )
}
