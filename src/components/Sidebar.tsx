import type { TagConfig } from '@/types'
import * as LucideIcons from 'lucide-react'
import { Settings, LayoutGrid } from 'lucide-react'

interface SidebarProps {
  tags: TagConfig[]
  activeTag: string | null // null = "All"
  onTagSelect: (tag: string | null) => void
  onSettingsClick: () => void
  open: boolean
  onClose: () => void
}

function getIconComponent(iconName: string) {
  console.log('[Sidebar] 加载图标:', iconName)
  const icons = LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>
  const Icon = icons[iconName]
  if (!Icon) {
    console.log('[Sidebar] 图标未找到:', iconName, '可用图标:', Object.keys(icons).slice(0, 20))
  }
  return Icon || LayoutGrid
}

export default function Sidebar({ tags, activeTag, onTagSelect, onSettingsClick, open, onClose }: SidebarProps) {
  const sortedTags = [...tags].sort((a, b) => a.order - b.order)

  const handleTagClick = (tag: string | null) => {
    onTagSelect(tag)
    onClose()
  }

  const handleSettingsClick = () => {
    onSettingsClick()
    onClose()
  }

  return (
    <>
      {/* 遮罩层（手机端） */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={onClose}
        />
      )}
      <div className={`fixed left-0 top-0 bottom-0 w-[60px] bg-black/30 backdrop-blur-md border-r border-white/10 flex flex-col items-center py-4 z-40 transition-transform duration-200 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}>
        {/* All button */}
        <button
          onClick={() => handleTagClick(null)}
          className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all mb-2 ${
            activeTag === null
              ? 'bg-white/20 text-white'
              : 'text-white/60 hover:bg-white/10 hover:text-white/80'
          }`}
          title="All"
        >
          <LayoutGrid className="w-5 h-5" />
        </button>

        {/* Tag buttons */}
        <div className="flex-1 flex flex-col items-center gap-1 overflow-y-auto scrollbar-thin">
          {sortedTags.map((tag) => {
            const Icon = getIconComponent(tag.icon)
            return (
              <button
                key={tag.id}
                onClick={() => handleTagClick(tag.tag)}
                className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                  activeTag === tag.tag
                    ? 'bg-white/20 text-white'
                    : 'text-white/60 hover:bg-white/10 hover:text-white/80'
                }`}
                title={tag.label}
              >
                <Icon className="w-5 h-5" />
              </button>
            )
          })}
        </div>

        {/* Settings button */}
        <button
          onClick={handleSettingsClick}
          className="w-10 h-10 rounded-xl flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white/80 transition-all mt-2"
          title="Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </>
  )
}
