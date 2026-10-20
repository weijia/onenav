import type { AppMeta } from './manifest'

interface AppCardProps {
  app: AppMeta
  iconSize: number
  borderRadius: number
  nameSize: number
}

/** 书签区中展示的一个应用入口卡片（外观与书签卡片一致）。点击跳转到该应用的独立页面（单独的 HTML 文件）。 */
export default function AppCard({ app, iconSize, borderRadius, nameSize }: AppCardProps) {
  const Icon = app.icon

  return (
    <a
      href={app.entry}
      className="flex flex-col items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0 select-none group no-underline"
      style={{
        width: `${iconSize + 24}px`,
        touchAction: 'manipulation',
        WebkitTouchCallout: 'none',
        userSelect: 'none',
      } as React.CSSProperties}
      title={app.description}
    >
      <div
        className={`relative overflow-hidden transition-transform duration-200 group-hover:scale-105 flex items-center justify-center bg-gradient-to-br ${app.accent}`}
        style={{
          width: `${iconSize}px`,
          height: `${iconSize}px`,
          borderRadius: `${borderRadius}px`,
        }}
      >
        <Icon
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
        {app.name}
      </span>
    </a>
  )
}
