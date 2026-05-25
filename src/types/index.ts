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
  reachable?: boolean | null // null=未检测, true=可连接, false=不可连接
}
