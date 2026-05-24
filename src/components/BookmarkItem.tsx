import { useState } from 'react'
import type { DisplayBookmark } from '@/types'
import { Pin, Circle, Loader2 } from 'lucide-react'

interface BookmarkItemProps {
  bookmark: DisplayBookmark
  iconSize: number
  borderRadius: number
  showName: boolean
  nameSize: number
  openInNewTab: boolean
  onClick?: (bookmark: DisplayBookmark) => void
  onTogglePin?: (url: string) => void
}

export default function BookmarkItem({
  bookmark,
  iconSize,
  borderRadius,
  showName,
  nameSize,
  openInNewTab,
  onClick,
  onTogglePin,
}: BookmarkItemProps) {
  const [imgError, setImgError] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)

  const firstLetter = bookmark.title.charAt(0).toUpperCase()

  const handleClick = () => {
    onClick?.(bookmark)
    if (openInNewTab) {
      window.open(bookmark.url, '_blank')
    } else {
      window.location.href = bookmark.url
    }
  }

  const handlePinClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onTogglePin?.(bookmark.url)
  }

  // 连接状态指示器
  const renderReachability = () => {
    const { reachable } = bookmark
    if (reachable === null || reachable === undefined) {
      // 未检测：不显示
      return null
    }
    if (reachable === true) {
      return (
        <span className="absolute -top-1 -left-1 z-10 w-3 h-3 rounded-full bg-green-500 border border-white/30" title="可连接" />
      )
    }
    return (
      <span className="absolute -top-1 -left-1 z-10 w-3 h-3 rounded-full bg-red-500 border border-white/30" title="不可连接" />
    )
  }

  return (
    <div className="relative flex flex-col items-center gap-1.5 group w-full">
      {/* Reachability indicator */}
      {renderReachability()}

      {/* Pin button */}
      <button
        onClick={handlePinClick}
        className={`absolute -top-1 -right-1 z-10 w-5 h-5 rounded-full flex items-center justify-center transition-all ${
          bookmark.isPinned
            ? 'bg-yellow-500 text-white opacity-100'
            : 'bg-white/20 text-white/60 opacity-40 group-hover:opacity-100 hover:bg-white/40'
        }`}
        title={bookmark.isPinned ? '取消固定' : '固定书签'}
      >
        <Pin className="w-3 h-3" fill={bookmark.isPinned ? 'currentColor' : 'none'} />
      </button>

      <button
        onClick={handleClick}
        className="flex flex-col items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0 w-full"
        title={`${bookmark.title}\n${bookmark.url}`}
      >
        <div
          className="relative overflow-hidden transition-transform duration-200 group-hover:scale-105 flex items-center justify-center"
          style={{
            width: `${iconSize}px`,
            height: `${iconSize}px`,
            borderRadius: `${borderRadius}px`,
            backgroundColor: bookmark.color,
          }}
        >
          {bookmark.favicon && !imgError ? (
            <img
              src={bookmark.favicon}
              alt=""
              className="object-contain w-3/5 h-3/5 transition-opacity duration-200"
              style={{ opacity: imgLoaded ? 1 : 0 }}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              loading="lazy"
            />
          ) : (
            <span
              className="font-semibold text-white/90 select-none"
              style={{ fontSize: `${iconSize * 0.4}px` }}
            >
              {firstLetter}
            </span>
          )}
        </div>
        {showName && (
          <span
            className="text-white/80 text-center leading-tight overflow-hidden transition-colors group-hover:text-white"
            style={{
              fontSize: `${nameSize}px`,
              maxWidth: `${iconSize + 8}px`,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {bookmark.title}
          </span>
        )}
      </button>
    </div>
  )
}
