import { useRef, useEffect, useState } from 'react'
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
  onItemClick?: (bookmark: DisplayBookmark) => void
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
  onItemClick,
}: BookmarkGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(6)

  useEffect(() => {
    const calculateColumns = () => {
      if (!containerRef.current) return
      const containerWidth = containerRef.current.clientWidth
      const itemWidth = iconSize + spacing + 8 // +8 for safety margin
      const newColumns = Math.max(3, Math.floor(containerWidth / itemWidth))
      setColumns(newColumns)
    }

    calculateColumns()
    window.addEventListener('resize', calculateColumns)
    return () => window.removeEventListener('resize', calculateColumns)
  }, [iconSize, spacing])

  if (bookmarks.length === 0) {
    return (
      <div className="text-center text-white/40 py-20">
        <p className="text-lg">No bookmarks found</p>
        <p className="text-sm mt-2">Configure tags in settings to display bookmarks</p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="mx-auto animate-slide-in w-full px-2"
      style={{ maxWidth: `${maxWidth}px` }}
    >
      <div
        className="grid justify-items-center"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
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
            onClick={onItemClick}
          />
        ))}
      </div>
    </div>
  )
}
