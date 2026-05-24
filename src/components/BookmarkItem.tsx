import { useState } from 'react'
import type { DisplayBookmark } from '@/types'

interface BookmarkItemProps {
  bookmark: DisplayBookmark
  iconSize: number
  borderRadius: number
  showName: boolean
  nameSize: number
  openInNewTab: boolean
  onClick?: (bookmark: DisplayBookmark) => void
}

export default function BookmarkItem({
  bookmark,
  iconSize,
  borderRadius,
  showName,
  nameSize,
  openInNewTab,
  onClick,
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

  return (
    <button
      onClick={handleClick}
      className="flex flex-col items-center gap-1.5 group cursor-pointer bg-transparent border-0 p-0 w-full"
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
  )
}
