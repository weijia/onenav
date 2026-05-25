import { useState, useRef } from 'react'
import type { DisplayBookmark } from '@/types'
import { Pin } from 'lucide-react'

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
  const [showTooltip, setShowTooltip] = useState(false)
  const longPressTimer = useRef<number | null>(null)

  const firstLetter = bookmark.title.charAt(0).toUpperCase()

  // 生成完整的提示文本
  const tooltipContent = () => {
    const parts = [
      bookmark.title,
      bookmark.url,
    ]
    if (bookmark.tags.length > 0) {
      parts.push(`标签: ${bookmark.tags.join(', ')}`)
    }
    if (bookmark.description) {
      parts.push(`描述: ${bookmark.description}`)
    }
    return parts.join('\n')
  }

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

  // 长按处理（移动端）
  const handleTouchStart = () => {
    longPressTimer.current = window.setTimeout(() => {
      setShowTooltip(true)
    }, 500) // 500ms 长按
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    setTimeout(() => setShowTooltip(false), 2000) // 2秒后隐藏
  }

  return (
    <div className="relative flex flex-col items-center gap-1.5 group w-full">
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

      {/* 长按提示（移动端） */}
      {showTooltip && (
        <div className="absolute -top-16 left-1/2 -translate-x-1/2 z-50 bg-black/90 text-white text-xs p-3 rounded-lg whitespace-pre-line max-w-xs pointer-events-none">
          {tooltipContent()}
        </div>
      )}

      <button
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="flex flex-col items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0 w-full"
        title={tooltipContent()}
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
