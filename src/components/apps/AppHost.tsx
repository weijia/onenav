import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeft } from 'lucide-react'

interface AppHostProps {
  /** 应用名称 */
  name: string
  /** 一句话描述 */
  description: string
  /** 卡片渐变背景（tailwind from-/to- 类） */
  accent: string
  /** 图标（lucide 组件） */
  icon: LucideIcon
  /** 应用页面组件（由各自入口直接传入，主 bundle 不含此组件） */
  component: ComponentType
  /** 返回书签区 */
  onBack: () => void
}

/**
 * 内置应用的独立页面容器：顶部返回栏 + 应用页面主体。
 * 这是一个纯展示组件——页面组件由各应用入口（apps/<id>/entry.tsx）直接传入，
 * 从而保持主 bundle 不含任何应用代码。
 */
export default function AppHost({ name, description, accent, icon: Icon, component: AppComp, onBack }: AppHostProps) {
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 shrink-0">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all"
          title="返回书签"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${accent} flex items-center justify-center`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-white/90 font-medium leading-tight">{name}</h2>
          <p className="text-white/40 text-xs">{description}</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <AppComp />
      </div>
    </div>
  )
}
