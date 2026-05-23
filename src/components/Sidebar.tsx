import type { TagConfig } from '@/types'
import * as LucideIcons from 'lucide-react'
import { Settings, LayoutGrid } from 'lucide-react'

interface SidebarProps {
  tags: TagConfig[]
  activeTag: string | null // null = "All"
  onTagSelect: (tag: string | null) => void
  onSettingsClick: () => void
}

function getIconComponent(iconName: string) {
  const icons = LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>
  const Icon = icons[iconName]
  return Icon || LayoutGrid
}

export default function Sidebar({ tags, activeTag, onTagSelect, onSettingsClick }: SidebarProps) {
  const sortedTags = [...tags].sort((a, b) => a.order - b.order)

  return (
    <div className="fixed left-0 top-0 bottom-0 w-[60px] bg-black/30 backdrop-blur-md border-r border-white/10 flex flex-col items-center py-4 z-40">
      {/* All button */}
      <button
        onClick={() => onTagSelect(null)}
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
              onClick={() => onTagSelect(tag.tag)}
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
        onClick={onSettingsClick}
        className="w-10 h-10 rounded-xl flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white/80 transition-all mt-2"
        title="Settings"
      >
        <Settings className="w-5 h-5" />
      </button>
    </div>
  )
}
