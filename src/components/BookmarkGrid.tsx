import type { DisplayBookmark } from '@/types'
import BookmarkItem from '@/components/BookmarkItem'

interface BookmarkGridProps {
  bookmarks: DisplayBookmark[]
  iconSize: number
  borderRadius: number
  spacing: number
  showName: boolean
  nameSize: number
  maxWidth: number
  openInNewTab: boolean
}

export default function BookmarkGrid({
  bookmarks,
  iconSize,
  borderRadius,
  spacing,
  showName,
  nameSize,
  maxWidth,
  openInNewTab,
}: BookmarkGridProps) {
  if (bookmarks.length === 0) {
    return (
      <div className="text-center text-white/40 py-20">
        <p className="text-lg">No bookmarks found</p>
        <p className="text-sm mt-2">Configure tags in settings to display bookmarks</p>
      </div>
    )
  }

  // Calculate columns based on available width and icon size + spacing
  const itemWidth = iconSize + spacing
  const columns = Math.max(4, Math.min(24, Math.floor(maxWidth / itemWidth)))

  return (
    <div
      className="mx-auto px-4 animate-slide-in"
      style={{ maxWidth: `${maxWidth}px` }}
    >
      <div
        className="grid justify-items-center"
        style={{
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: `${spacing}px`,
        }}
      >
        {bookmarks.map((bookmark, index) => (
          <BookmarkItem
            key={`${bookmark.url}-${index}`}
            bookmark={bookmark}
            iconSize={iconSize}
            borderRadius={borderRadius}
            showName={showName}
            nameSize={nameSize}
            openInNewTab={openInNewTab}
          />
        ))}
      </div>
    </div>
  )
}
