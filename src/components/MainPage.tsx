import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { AppConfig, DisplayBookmark, WebDAVConfig, BookmarksStore } from '@/types'
import { loadWebDAVConfig, loadAppConfig, fetchAppConfig, fetchBookmarks, getDefaultAppConfig, saveAppConfig, saveAppConfigToWebDAV, loadBookmarksCache } from '@/lib/config'
import { filterByTag, getMostVisitedBookmarks, isDeleted, getFaviconUrl, stringToColor } from '@/lib/bookmarks'
import { recordClick, loadClickStatsFromWebDAV, togglePinnedBookmark, loadPinnedBookmarks, savePinnedBookmarks } from '@/lib/stats'
import { checkUrlReachable } from '@/lib/reachability'
import Sidebar from '@/components/Sidebar'
import BookmarkGrid from '@/components/BookmarkGrid'
import SettingsDialog from '@/components/SettingsDialog'
import { RefreshCw, Loader2, LayoutGrid, Search } from 'lucide-react'
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
  const [allBookmarks, setAllBookmarks] = useState<DisplayBookmark[]>([])
  const [pinnedUrls, setPinnedUrls] = useState<string[]>(loadPinnedBookmarks())
  const cachedStoreRef = useRef(false)
  const processBookmarksRef = useRef<((store: BookmarksStore, config: AppConfig) => void) | undefined>(undefined)

  const loadAllData = useCallback(async (wdav: WebDAVConfig, showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')

    try {
      // Load click stats from WebDAV and merge with local
      await loadClickStatsFromWebDAV(wdav)

      // Load app config from WebDAV or fall back to localStorage
      let config = await fetchAppConfig(wdav)
      if (!config) {
        config = loadAppConfig() || getDefaultAppConfig()
      }
      setAppConfig(config)

      // 从配置文件恢复固定书签列表
      if (config.pinnedBookmarks && config.pinnedBookmarks.length > 0) {
        setPinnedUrls(config.pinnedBookmarks)
        savePinnedBookmarks(config.pinnedBookmarks)
      }

      // 先从本地缓存加载，立即显示
      const cachedStore = loadBookmarksCache()
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

  // 当书签列表变化时，自动检测连接状态
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7天过期

  useEffect(() => {
    if (bookmarks.length === 0) return

    const cache = appConfig.reachabilityCache || {}
    const now = Date.now()

    // 先用缓存的结果设置状态，避免闪烁（保持已有状态直到新检测完成）
    setBookmarks(prev => prev.map(b => {
      const entry = cache[b.url]
      if (entry && (now - entry.checkedAt) < CACHE_TTL) {
        return { ...b, reachable: entry.reachable }
      }
      // 缓存过期时保持当前显示状态，不重置为 null
      return b
    }))

    // 并发检测，只检测缓存中没有的或已过期的
    const newCache = { ...cache }
    let cacheChanged = false

    bookmarks.forEach((bookmark) => {
      const entry = newCache[bookmark.url]
      if (entry && (now - entry.checkedAt) < CACHE_TTL) {
        return // 未过期，跳过
      }
      // 标记为检测中
      setBookmarks(prev =>
        prev.map(b => b.url === bookmark.url ? { ...b, reachable: 'checking' } : b)
      )
      checkUrlReachable(bookmark.url).then(reachable => {
        newCache[bookmark.url] = { reachable, checkedAt: Date.now() }
        cacheChanged = true
        setBookmarks(prev =>
          prev.map(b => b.url === bookmark.url ? { ...b, reachable } : b)
        )
      })
    })

    // 检测完成后同步缓存到配置
    // 使用定时检查：当所有检测完成后保存一次
    const checkInterval = setInterval(() => {
      if (cacheChanged) {
        const updatedConfig = { ...appConfig, reachabilityCache: newCache }
        setAppConfig(updatedConfig)
        saveAppConfig(updatedConfig)
        if (webdavConfig) {
          saveAppConfigToWebDAV(webdavConfig, updatedConfig).catch(() => {})
        }
        cacheChanged = false
      }
    }, 3000) // 每3秒检查一次是否有新结果需要保存

    return () => clearInterval(checkInterval)
  }, [activeTag, appConfig.reachabilityCache])

  useEffect(() => {
    const wdav = loadWebDAVConfig()
    if (!wdav) return
    setWebdavConfig(wdav)
    loadAllData(wdav)
  }, [loadAllData])

  // Re-process bookmarks when active tag changes
  useEffect(() => {
    if (!webdavConfig) return

    const loadAndFilter = async () => {
      const store = await fetchBookmarks(webdavConfig, appConfig.bookmarkPath)
      if (store) {
        processBookmarks(store, appConfig)
      }
    }

    loadAndFilter()
  }, [activeTag, webdavConfig, appConfig, processBookmarks])

  const handleRefresh = async () => {
    if (!webdavConfig || refreshing) return
    setRefreshing(true)
    await loadAllData(webdavConfig, false)
    setRefreshing(false)
  }

  const handleConfigSave = (config: AppConfig) => {
    setAppConfig(config)
    saveAppConfig(config)
  }

  const handleTagSelect = (tag: string | null) => {
    setActiveTag(tag)
    setSearchQuery('')
    window.location.hash = tag || ''
  }

  const handleTogglePin = (url: string) => {
    togglePinnedBookmark(url)
    const newPinned = loadPinnedBookmarks()
    setPinnedUrls(newPinned)

    // 同步到配置文件（localStorage + WebDAV）
    const updatedConfig = { ...appConfig, pinnedBookmarks: newPinned }
    setAppConfig(updatedConfig)
    saveAppConfig(updatedConfig)
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
      />

      {/* Main content */}
      <main className="relative z-10 min-h-screen flex flex-col overflow-x-hidden" style={{ marginLeft: '60px', width: 'calc(100% - 60px)' }}>
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
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
