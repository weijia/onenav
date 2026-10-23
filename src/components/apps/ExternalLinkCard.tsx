import { Globe } from 'lucide-react'

interface ExternalLinkCardProps {
  /** 链接地址 */
  url: string
  /** 显示名称 */
  title: string
  iconSize: number
  borderRadius: number
  nameSize: number
}

// 一组好看的渐变，按 URL 哈希稳定取色，让外链卡片也有统一风格
const ACCENTS = [
  'from-sky-500 to-blue-600',
  'from-violet-500 to-purple-600',
  'from-rose-500 to-pink-600',
  'from-amber-500 to-orange-600',
  'from-cyan-500 to-teal-600',
  'from-indigo-500 to-blue-700',
  'from-fuchsia-500 to-pink-700',
  'from-emerald-500 to-green-600',
]

function pickAccent(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0
  return ACCENTS[h % ACCENTS.length]
}

/**
 * 来自公共收藏源（如 Gitee favorites.json）的外链入口卡片。
 * 外观与内置 AppCard 一致，但点击会在新标签页打开目标网址。
 */
export default function ExternalLinkCard({ url, title, iconSize, borderRadius, nameSize }: ExternalLinkCardProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0 select-none group no-underline"
      style={{
        width: `${iconSize + 24}px`,
        touchAction: 'manipulation',
        WebkitTouchCallout: 'none',
        userSelect: 'none',
      } as React.CSSProperties}
      title={title}
    >
      <div
        className={`relative overflow-hidden transition-transform duration-200 group-hover:scale-105 flex items-center justify-center bg-gradient-to-br ${pickAccent(url)}`}
        style={{
          width: `${iconSize}px`,
          height: `${iconSize}px`,
          borderRadius: `${borderRadius}px`,
        }}
      >
        <Globe
          className="text-white"
          style={{ width: `${iconSize * 0.45}px`, height: `${iconSize * 0.45}px` }}
        />
      </div>
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
        {title}
      </span>
    </a>
  )
}
