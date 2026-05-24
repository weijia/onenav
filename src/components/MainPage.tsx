import { useState, useEffect, useCallback } from 'react'
import type { AppConfig, DisplayBookmark, WebDAVConfig, BookmarksStore } from '@/types'
import { loadWebDAVConfig, loadAppConfig, fetchAppConfig, fetchBookmarks, getDefaultAppConfig, saveAppConfig } from '@/lib/config'
import { filterByTag, filterByMultipleTags } from '@/lib/bookmarks'
import Sidebar from '@/components/Sidebar'
import TimeDisplay from '@/components/TimeDisplay'
import SearchBar from '@/components/SearchBar'
import BookmarkGrid from '@/components/BookmarkGrid'
import SettingsDialog from '@/components/SettingsDialog'
import { RefreshCw, Loader2, LayoutGrid } from 'lucide-react'
import { versionDisplay, buildTimeDisplay } from '@/lib/version'

export default function MainPage() {
  const [webdavConfig, setWebdavConfig] = useState<WebDAVConfig | null>(null)
  const [appConfig, setAppConfig] = useState<AppConfig>(getDefaultAppConfig())
  const [bookmarks, setBookmarks] = useState<DisplayBookmark[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const loadAllData = useCallback(async (wdav: WebDAVConfig, showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')

    try {
      // Load app config from WebDAV or fall back to localStorage
      let config = await fetchAppConfig(wdav)
      if (!config) {
        config = loadAppConfig() || getDefaultAppConfig()
      }
      setAppConfig(config)

      // Load bookmarks
      const store = await fetchBookmarks(wdav, config.bookmarkPath)
      if (store) {
        processBookmarks(store, config)
      }
    } catch (err) {
      setError(`Failed to load data: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const processBookmarks = useCallback((store: BookmarksStore, config: AppConfig) => {
    const configuredTags = config.tags.map((t) => t.tag)

    if (configuredTags.length === 0) {
      setBookmarks([])
      return
    }

    if (activeTag === null) {
      // Show all bookmarks from all configured tags
      setBookmarks(filterByMultipleTags(store, configuredTags))
    } else {
      setBookmarks(filterByTag(store, activeTag))
    }
  }, [activeTag])

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
      <main className="relative z-10 min-h-screen flex flex-col" style={{ marginLeft: '60px', width: 'calc(100vw - 60px)' }}>
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
          {/* Bookmark grid */}
          <div className="w-full overflow-x-auto">
            <BookmarkGrid
              bookmarks={bookmarks}
              iconSize={appConfig.display.iconSize}
              borderRadius={appConfig.display.iconBorderRadius}
              spacing={appConfig.display.iconSpacing}
              showName={appConfig.display.showName}
              nameSize={appConfig.display.nameSize}
              maxWidth={appConfig.display.maxWidth}
              openInNewTab={appConfig.display.openInNewTab}
            />
          </div>
        </div>

        {/* Version info */}
        <div className="text-center pb-4 text-white/20 text-xs">
          <span>{versionDisplay}</span>
          <span className="mx-2">·</span>
          <span>{buildTimeDisplay}</span>
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
