import { useState, useEffect } from 'react'
import type { AppConfig, TagConfig, WebDAVConfig, ArchiveResult } from '@/types'
import { loadWebDAVConfig, saveWebDAVConfig, saveAppConfigToWebDAV, getDefaultAppConfig } from '@/lib/config'
import { archiveFavorites } from '@/lib/favorites'
import { archiveFavoritesOnRS, isRemoteStorageFavoritesAvailable } from '@/lib/favorites-remotestorage'
import { getStorageCredentials, onStatusChange } from '@/lib/remotestorage-connection'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Plus, Trash2, GripVertical } from 'lucide-react'
import RemoteStorageSync from '@/components/RemoteStorageSync'
import { getPouchDB } from '@/lib/pouchdb'

// Wrapper to load PouchDB instance
function RemoteStorageSyncWrapper() {
  const [db, setDb] = useState<PouchDB.Database | null>(null)
  
  useEffect(() => {
    getPouchDB().then(setDb)
  }, [])
  
  return <RemoteStorageSync db={db} />
}

// 归档结果日志视图（WebDAV / RemoteStorage 共用）
function ArchiveLogView({ log }: { log: ArchiveResult }) {
  if (!log) return null
  return (
    <div className="space-y-3 text-sm">
      {log.archived.length > 0 && (
        <div>
          <p className="text-green-400 mb-1">已归档（{log.archived.length}）</p>
          <div className="flex flex-wrap gap-1">
            {log.archived.map((ym) => (
              <span key={ym} className="px-2 py-0.5 rounded bg-green-500/15 text-green-300 text-xs">{ym}</span>
            ))}
          </div>
        </div>
      )}
      {log.skipped.length > 0 && (
        <div>
          <p className="text-white/40 mb-1">已跳过（{log.skipped.length}）</p>
          <div className="flex flex-wrap gap-1">
            {log.skipped.map((ym) => (
              <span key={ym} className="px-2 py-0.5 rounded bg-white/10 text-white/50 text-xs">{ym}</span>
            ))}
          </div>
        </div>
      )}
      {log.errors.length > 0 && (
        <div>
          <p className="text-red-400 mb-1">失败（{log.errors.length}）</p>
          <div className="space-y-1">
            {log.errors.map((e, i) => (
              <p key={i} className="text-red-300 text-xs">{e.ym}: {e.message}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: AppConfig
  onConfigSave: (config: AppConfig) => void
}

type SettingsTab = 'tags' | 'display' | 'background' | 'widgets' | 'webdav' | 'remotestorage' | 'favorites'

const ICON_NAMES = [
  'Globe', 'Code', 'BookOpen', 'Music', 'Video', 'Gamepad2',
  'ShoppingCart', 'Briefcase', 'GraduationCap', 'Heart',
  'Star', 'Camera', 'Palette', 'Wrench', 'Terminal',
  'Database', 'Cloud', 'Mail', 'MessageCircle', 'Newspaper',
  'Cpu', 'Smartphone', 'Monitor', 'Headphones', 'Mic',
  'Film', 'Tv', 'Radio', 'Disc', 'Library',
  'FileText', 'FolderOpen', 'Archive', 'Image', 'PenTool',
  'LayoutGrid', 'Layers', 'Boxes', 'Package', 'Home',
  'Map', 'Compass', 'Plane', 'Car', 'Bike',
  'Utensils', 'Coffee', 'Wine', 'Cake', 'Pizza',
  'Dumbbell', 'HeartPulse', 'Stethoscope', 'Pill', 'Thermometer',
  'Banknote', 'TrendingUp', 'BarChart3', 'PieChart', 'Activity',
  'Shield', 'Lock', 'Key', 'Fingerprint', 'Eye',
  'Github', 'Gitlab', 'Twitter', 'Youtube', 'Twitch',
]

export default function SettingsDialog({ open, onOpenChange, config, onConfigSave }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('tags')
  const [localConfig, setLocalConfig] = useState<AppConfig>(config)
  const [saving, setSaving] = useState(false)
  const [webdavInfo, setWebdavInfo] = useState<WebDAVConfig | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveLog, setArchiveLog] = useState<ArchiveResult | null>(null)
  const [rsConnected, setRsConnected] = useState(false)
  const [rsArchiving, setRsArchiving] = useState(false)
  const [rsArchiveLog, setRsArchiveLog] = useState<ArchiveResult | null>(null)

  useEffect(() => {
    if (open) {
      setLocalConfig(config)
      setWebdavInfo(loadWebDAVConfig())
      setRsConnected(isRemoteStorageFavoritesAvailable())
    }
  }, [open, config])

  // 订阅 RemoteStorage 连接状态变化
  useEffect(() => {
    const unsubscribe = onStatusChange((info) => {
      setRsConnected(info.status === 'connected' && !!getStorageCredentials())
    })
    return unsubscribe
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const wdav = loadWebDAVConfig()
      if (wdav) {
        await saveAppConfigToWebDAV(wdav, localConfig)
      }
      onConfigSave(localConfig)
      onOpenChange(false)
    } catch (err) {
      console.error('Failed to save config:', err)
    } finally {
      setSaving(false)
    }
  }

  const updateConfig = (updates: Partial<AppConfig>) => {
    setLocalConfig((prev) => ({ ...prev, ...updates }))
  }

  const updateDisplay = (updates: Partial<AppConfig['display']>) => {
    setLocalConfig((prev) => ({ ...prev, display: { ...prev.display, ...updates } }))
  }

  const updateBackground = (updates: Partial<AppConfig['background']>) => {
    setLocalConfig((prev) => ({ ...prev, background: { ...prev.background, ...updates } }))
  }

  const updateWidgets = (updates: Partial<AppConfig['widgets']>) => {
    setLocalConfig((prev) => ({ ...prev, widgets: { ...prev.widgets, ...updates } }))
  }

  // Tag management
  const addTag = () => {
    const newTag: TagConfig = {
      id: `tag-${Date.now()}`,
      label: 'New Tag',
      tag: 'new-tag',
      icon: 'Globe',
      order: localConfig.tags.length,
    }
    updateConfig({ tags: [...localConfig.tags, newTag] })
  }

  const removeTag = (id: string) => {
    updateConfig({ tags: localConfig.tags.filter((t) => t.id !== id) })
  }

  const updateTag = (id: string, updates: Partial<TagConfig>) => {
    updateConfig({
      tags: localConfig.tags.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })
  }

  const moveTag = (index: number, direction: 'up' | 'down') => {
    const tags = [...localConfig.tags].sort((a, b) => a.order - b.order)
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= tags.length) return

    const temp = tags[index]
    tags[index] = tags[newIndex]
    tags[newIndex] = temp

    updateConfig({
      tags: tags.map((t, i) => ({ ...t, order: i })),
    })
  }

  const resetToDefaults = () => {
    setLocalConfig(getDefaultAppConfig())
  }

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'tags', label: 'Tags' },
    { key: 'display', label: 'Display' },
    { key: 'background', label: 'Background' },
    { key: 'widgets', label: 'Widgets' },
    { key: 'webdav', label: 'WebDAV' },
    { key: 'remotestorage', label: 'RemoteStorage' },
    { key: 'favorites', label: '收藏归档' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col bg-gray-900/95 backdrop-blur-xl border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-white">Settings</DialogTitle>
          <DialogDescription className="text-white/50">Configure your OneNav homepage</DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-white/10 pb-0 overflow-x-auto scrollbar-hide -mx-1 px-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-2 text-sm whitespace-nowrap transition-colors border-b-2 shrink-0 ${
                activeTab === tab.key
                  ? 'border-white text-white'
                  : 'border-transparent text-white/50 hover:text-white/70'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {activeTab === 'tags' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-white/60">Configure tag categories for sidebar navigation</p>
                <Button onClick={addTag} size="sm" className="bg-white/10 hover:bg-white/20 text-white border border-white/20">
                  <Plus className="w-4 h-4 mr-1" /> Add Tag
                </Button>
              </div>

              {localConfig.tags.length === 0 && (
                <p className="text-center text-white/40 py-8">No tags configured. Add tags to organize your bookmarks.</p>
              )}

              {[...localConfig.tags].sort((a, b) => a.order - b.order).map((tag, index) => (
                <div key={tag.id} className="flex items-center gap-2 bg-white/5 rounded-lg p-3">
                  <div className="flex flex-col gap-0.5 text-white/30">
                    <button onClick={() => moveTag(index, 'up')} disabled={index === 0} className="hover:text-white/60 disabled:opacity-30">
                      <GripVertical className="w-3 h-3 rotate-180" />
                    </button>
                    <button onClick={() => moveTag(index, 'down')} disabled={index === localConfig.tags.length - 1} className="hover:text-white/60 disabled:opacity-30">
                      <GripVertical className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="flex-1 grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-white/60 text-xs">Label</Label>
                      <Input
                        value={tag.label}
                        onChange={(e) => updateTag(tag.id, { label: e.target.value })}
                        className="bg-white/10 border-white/20 text-white text-sm h-7"
                      />
                    </div>
                    <div>
                      <Label className="text-white/60 text-xs">Tag Name</Label>
                      <Input
                        value={tag.tag}
                        onChange={(e) => updateTag(tag.id, { tag: e.target.value })}
                        className="bg-white/10 border-white/20 text-white text-sm h-7"
                        placeholder="多个 tag 用逗号分隔"
                      />
                    </div>
                    <div>
                      <Label className="text-white/60 text-xs">Icon</Label>
                      <select
                        value={tag.icon}
                        onChange={(e) => updateTag(tag.id, { icon: e.target.value })}
                        className="w-full h-7 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-2 outline-none focus:border-white/40"
                      >
                        {ICON_NAMES.map((name) => (
                          <option key={name} value={name} className="bg-gray-900">{name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <Button
                    onClick={() => removeTag(tag.id)}
                    variant="ghost"
                    size="icon-sm"
                    className="text-white/40 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'display' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Icon Size</Label>
                  <span className="text-white/60 text-sm">{localConfig.display.iconSize}px</span>
                </div>
                <input
                  type="range"
                  min="32"
                  max="120"
                  value={localConfig.display.iconSize}
                  onChange={(e) => updateDisplay({ iconSize: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Border Radius</Label>
                  <span className="text-white/60 text-sm">{localConfig.display.iconBorderRadius}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="32"
                  value={localConfig.display.iconBorderRadius}
                  onChange={(e) => updateDisplay({ iconBorderRadius: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Spacing</Label>
                  <span className="text-white/60 text-sm">{localConfig.display.iconSpacing}px</span>
                </div>
                <input
                  type="range"
                  min="8"
                  max="60"
                  value={localConfig.display.iconSpacing}
                  onChange={(e) => updateDisplay({ iconSpacing: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Name Size</Label>
                  <span className="text-white/60 text-sm">{localConfig.display.nameSize}px</span>
                </div>
                <input
                  type="range"
                  min="8"
                  max="20"
                  value={localConfig.display.nameSize}
                  onChange={(e) => updateDisplay({ nameSize: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Max Width</Label>
                  <span className="text-white/60 text-sm">{localConfig.display.maxWidth}px</span>
                </div>
                <input
                  type="range"
                  min="600"
                  max="2400"
                  step="100"
                  value={localConfig.display.maxWidth}
                  onChange={(e) => updateDisplay({ maxWidth: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-white/80">Show Name</Label>
                <button
                  onClick={() => updateDisplay({ showName: !localConfig.display.showName })}
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    localConfig.display.showName ? 'bg-white/30' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      localConfig.display.showName ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-white/80">Open in New Tab</Label>
                <button
                  onClick={() => updateDisplay({ openInNewTab: !localConfig.display.openInNewTab })}
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    localConfig.display.openInNewTab ? 'bg-white/30' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      localConfig.display.openInNewTab ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">Default Icon Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={localConfig.display.defaultColor}
                    onChange={(e) => updateDisplay({ defaultColor: e.target.value })}
                    className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  />
                  <Input
                    value={localConfig.display.defaultColor}
                    onChange={(e) => updateDisplay({ defaultColor: e.target.value })}
                    className="bg-white/10 border-white/20 text-white text-sm h-8 flex-1"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'background' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-white/80">Background Type</Label>
                <div className="flex gap-2">
                  {(['gradient', 'image', 'color'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => updateBackground({ type })}
                      className={`px-3 py-1.5 rounded-lg text-sm transition-colors capitalize ${
                        localConfig.background.type === type
                          ? 'bg-white/20 text-white'
                          : 'bg-white/5 text-white/50 hover:bg-white/10'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">
                  {localConfig.background.type === 'gradient' ? 'Gradient Classes' :
                   localConfig.background.type === 'image' ? 'Image URL' : 'Color Value'}
                </Label>
                <Input
                  value={localConfig.background.value}
                  onChange={(e) => updateBackground({ value: e.target.value })}
                  placeholder={
                    localConfig.background.type === 'gradient'
                      ? 'from-blue-900 via-purple-900 to-indigo-900'
                      : localConfig.background.type === 'image'
                      ? 'https://example.com/image.jpg'
                      : '#1a1a2e'
                  }
                  className="bg-white/10 border-white/20 text-white text-sm"
                />
                {localConfig.background.type === 'gradient' && (
                  <p className="text-xs text-white/40">Use Tailwind gradient classes (from-X via-Y to-Z)</p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Mask Opacity</Label>
                  <span className="text-white/60 text-sm">{localConfig.background.maskOpacity}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.8"
                  step="0.05"
                  value={localConfig.background.maskOpacity}
                  onChange={(e) => updateBackground({ maskOpacity: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Background Blur</Label>
                  <span className="text-white/60 text-sm">{localConfig.background.blur}px</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="20"
                  value={localConfig.background.blur}
                  onChange={(e) => updateBackground({ blur: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>
            </div>
          )}

          {activeTab === 'widgets' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-white/80">Show Time</Label>
                <button
                  onClick={() => updateWidgets({ showTime: !localConfig.widgets.showTime })}
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    localConfig.widgets.showTime ? 'bg-white/30' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      localConfig.widgets.showTime ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-white/80">Show Search Bar</Label>
                <button
                  onClick={() => updateWidgets({ showSearchBar: !localConfig.widgets.showSearchBar })}
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    localConfig.widgets.showSearchBar ? 'bg-white/30' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      localConfig.widgets.showSearchBar ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-white/80">Show Seconds</Label>
                <button
                  onClick={() => updateWidgets({ showSeconds: !localConfig.widgets.showSeconds })}
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    localConfig.widgets.showSeconds ? 'bg-white/30' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      localConfig.widgets.showSeconds ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">Search Engine</Label>
                <select
                  value={localConfig.widgets.searchEngine}
                  onChange={(e) => updateWidgets({ searchEngine: e.target.value })}
                  className="w-full h-8 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-2 outline-none focus:border-white/40"
                >
                  <option value="google" className="bg-gray-900">Google</option>
                  <option value="bing" className="bg-gray-900">Bing</option>
                  <option value="baidu" className="bg-gray-900">Baidu</option>
                  <option value="duckduckgo" className="bg-gray-900">DuckDuckGo</option>
                </select>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Font Size</Label>
                  <span className="text-white/60 text-sm">{localConfig.widgets.fontSize}px</span>
                </div>
                <input
                  type="range"
                  min="30"
                  max="150"
                  value={localConfig.widgets.fontSize}
                  onChange={(e) => updateWidgets({ fontSize: Number(e.target.value) })}
                  className="w-full accent-white"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">Font Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={localConfig.widgets.fontColor}
                    onChange={(e) => updateWidgets({ fontColor: e.target.value })}
                    className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  />
                  <Input
                    value={localConfig.widgets.fontColor}
                    onChange={(e) => updateWidgets({ fontColor: e.target.value })}
                    className="bg-white/10 border-white/20 text-white text-sm h-8 flex-1"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'webdav' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-white/80">WebDAV URL</Label>
                <Input
                  value={webdavInfo?.url || ''}
                  onChange={(e) => setWebdavInfo(prev => prev ? { ...prev, url: e.target.value } : { url: e.target.value, username: '', password: '' })}
                  placeholder="https://example.com/dav"
                  className="bg-white/10 border-white/20 text-white text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">Username</Label>
                <Input
                  value={webdavInfo?.username || ''}
                  onChange={(e) => setWebdavInfo(prev => prev ? { ...prev, username: e.target.value } : { url: '', username: e.target.value, password: '' })}
                  placeholder="username"
                  className="bg-white/10 border-white/20 text-white text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">Password</Label>
                <Input
                  type="password"
                  value={webdavInfo?.password || ''}
                  onChange={(e) => setWebdavInfo(prev => prev ? { ...prev, password: e.target.value } : { url: '', username: '', password: e.target.value })}
                  placeholder="password"
                  className="bg-white/10 border-white/20 text-white text-sm"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-white/80">Bookmark Data Path</Label>
                <Input
                  value={localConfig.bookmarkPath}
                  onChange={(e) => updateConfig({ bookmarkPath: e.target.value })}
                  className="bg-white/10 border-white/20 text-white text-sm"
                />
                <p className="text-xs text-white/40">Path to the utags-bookmarks.json file on WebDAV</p>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-white/80">Auto Refresh Interval</Label>
                  <span className="text-white/60 text-sm">
                    {localConfig.autoRefreshInterval ?? 60} min
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="240"
                  step="5"
                  value={localConfig.autoRefreshInterval ?? 60}
                  onChange={(e) => updateConfig({ autoRefreshInterval: Number(e.target.value) })}
                  className="w-full accent-white"
                />
                <p className="text-xs text-white/40">
                  {localConfig.autoRefreshInterval === 0
                    ? 'Auto refresh disabled'
                    : `Automatically refresh data every ${localConfig.autoRefreshInterval ?? 60} minutes`}
                </p>
              </div>

              <div className="pt-4 flex gap-2 border-t border-white/10">
                <Button
                  onClick={() => {
                    if (webdavInfo) {
                      saveWebDAVConfig(webdavInfo)
                      alert('WebDAV 配置已保存')
                    }
                  }}
                  className="bg-white/10 hover:bg-white/20 text-white border border-white/20"
                >
                  保存 WebDAV 配置
                </Button>
                <Button
                  onClick={resetToDefaults}
                  variant="outline"
                  className="bg-white/5 border-white/20 text-white/60 hover:text-white hover:bg-white/10"
                >
                  Reset to Defaults
                </Button>
              </div>
            </div>
          )}

          {activeTab === 'remotestorage' && (
            <div className="space-y-4">
              <p className="text-sm text-white/60">
                Sync your PouchDB data to RemoteStorage for distributed storage across cloud providers.
              </p>
              <RemoteStorageSyncWrapper />
            </div>
          )}

          {activeTab === 'favorites' && (
            <div className="space-y-4">
              <p className="text-sm text-white/60">
                收藏书签位于 WebDAV 的 <code className="text-white/80">app_data/favorites/YYYY/YYYY-MM/bm_*.json</code>。
                归档会把历史月份的单文件合并为 <code className="text-white/80">archive-YYYY-MM.json</code> 快照（当前月永不归档）。
                系统会在新月份第一天自动归档；也可在此手动触发。
              </p>

              <div className="flex items-center gap-2">
                <Button
                  onClick={async () => {
                    const wdav = loadWebDAVConfig()
                    if (!wdav) {
                      alert('请先在 WebDAV 标签页配置连接')
                      return
                    }
                    setArchiving(true)
                    setArchiveLog(null)
                    try {
                      const res = await archiveFavorites(wdav)
                      setArchiveLog(res)
                    } catch (e) {
                      setArchiveLog({ archived: [], skipped: [], errors: [{ ym: '-', message: e instanceof Error ? e.message : String(e) }] })
                    } finally {
                      setArchiving(false)
                    }
                  }}
                  disabled={archiving}
                  className="bg-white/10 hover:bg-white/20 text-white border border-white/20"
                >
                  {archiving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      归档中...
                    </>
                  ) : (
                    '运行归档'
                  )}
                </Button>
              </div>

              {archiveLog && <ArchiveLogView log={archiveLog} />}

              <hr className="border-white/10" />

              <div className="space-y-3 pt-1">
                <p className="text-sm font-medium text-white/80">RemoteStorage 收藏源</p>
                <p className="text-sm text-white/60">
                  复用上方「RemoteStorage」标签页已登录的连接（同一个存储账号），
                  书签同样位于 <code className="text-white/80">app_data/favorites/...</code>，无需单独配置地址与 Token。
                </p>

                {rsConnected ? (
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={async () => {
                        setRsArchiving(true)
                        setRsArchiveLog(null)
                        try {
                          const res = await archiveFavoritesOnRS()
                          setRsArchiveLog(res)
                        } catch (e) {
                          setRsArchiveLog({ archived: [], skipped: [], errors: [{ ym: '-', message: e instanceof Error ? e.message : String(e) }] })
                        } finally {
                          setRsArchiving(false)
                        }
                      }}
                      disabled={rsArchiving}
                      className="bg-white/10 hover:bg-white/20 text-white border border-white/20"
                    >
                      {rsArchiving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-1" />
                          归档中...
                        </>
                      ) : (
                        '运行归档（RemoteStorage）'
                      )}
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-yellow-300/80">
                    尚未连接 RemoteStorage。请先在「RemoteStorage」标签页完成登录，即可使用收藏归档功能。
                  </p>
                )}

                {rsArchiveLog && <ArchiveLogView log={rsArchiveLog} />}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-white/10">
          <Button
            onClick={() => onOpenChange(false)}
            variant="outline"
            className="bg-white/5 border-white/20 text-white/60 hover:text-white hover:bg-white/10"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-white/20 hover:bg-white/30 text-white border border-white/20"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
                Saving...
              </>
            ) : (
              'Save'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
