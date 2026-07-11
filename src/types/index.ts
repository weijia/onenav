// WebDAV connection config (shared)
export interface WebDAVConfig {
  url: string
  username: string
  password: string
}

// App config (app_data/onenav/config.json)
export interface TagConfig {
  id: string
  label: string
  tag: string
  icon: string // Lucide icon name
  order: number
}

export interface DisplayConfig {
  iconSize: number
  iconBorderRadius: number
  iconSpacing: number
  showName: boolean
  nameSize: number
  maxWidth: number
  openInNewTab: boolean
  defaultColor: string
}

export interface BackgroundConfig {
  type: 'gradient' | 'image' | 'color'
  value: string
  maskOpacity: number
  blur: number
}

export interface WidgetsConfig {
  showTime: boolean
  showSearchBar: boolean
  showSeconds: boolean
  searchEngine: string
  fontSize: number
  fontColor: string
}

export interface AppConfig {
  version: number
  tags: TagConfig[]
  bookmarkPath: string
  display: DisplayConfig
  background: BackgroundConfig
  widgets: WidgetsConfig
  pinnedBookmarks?: string[] // 固定的书签 URL 列表
  autoRefreshInterval?: number // 自动刷新间隔（分钟），0 表示禁用，默认 60
}

// utags bookmark types (simplified)
export interface BookmarkMeta {
  url?: string
  title?: string
  shortTitle?: string
  description?: string
  note?: string
  favicon?: string
  coverImage?: string
  mainUrl?: string
  created?: number
  updated?: number
  deleted?: number
  lang?: string
  rating?: number
  read?: boolean
}

export interface BookmarkEntry {
  tags: string[]
  meta: BookmarkMeta
  hilights?: Array<{ text: string; color: string; note?: string }>
  deletedMeta?: { deleted: number; actionType: string }
}

export interface BookmarksStore {
  data: Record<string, BookmarkEntry>
  meta: {
    databaseVersion: number
    extensionVersion?: string
    created: number
    updated: number
  }
}

// Processed bookmark for display
export interface DisplayBookmark {
  url: string
  title: string
  description: string
  favicon: string
  color: string
  tags: string[]
  isPinned: boolean
}

// 收藏书签原始结构（app_data/favorites/YYYY/YYYY-MM/bm_*.json）
// 字段与 PouchDB BookmarkDoc 基本一致
export interface RawFavoritesBookmark {
  _id?: string
  type?: string
  url: string
  title?: string
  tags?: string[]
  description?: string
  icon?: string
  clicks?: number
  lastClickedAt?: number
  createdAt?: number
  updatedAt?: number
  deleted?: boolean
}

// 归档执行结果
export interface ArchiveResult {
  archived: string[] // 成功归档的 YYYY-MM
  skipped: string[] // 跳过的 YYYY-MM（已存在 / 当月）
  errors: { ym: string; message: string }[] // 失败月份
}
