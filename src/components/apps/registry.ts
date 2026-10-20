import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Wallet } from 'lucide-react'
import BookkeepingApp from './BookkeepingApp'

/** 内置小应用的定义 */
export interface AppDefinition {
  /** 唯一 id，同时作为数据文档前缀（app:<id>） */
  id: string
  /** 显示名称 */
  name: string
  /** 图标（lucide 组件） */
  icon: LucideIcon
  /** 卡片渐变背景（tailwind from-/to- 类） */
  accent: string
  /** 一句话描述 */
  description: string
  /** 应用页面组件（独立页面） */
  component: ComponentType
  /** 默认是否隐藏；缺省为 false（即默认显示） */
  defaultHidden?: boolean
}

/** 所有内置应用的注册表。新增小应用只需在此追加一项并实现其页面组件。 */
export const APP_REGISTRY: AppDefinition[] = [
  {
    id: 'bookkeeping',
    name: '记账',
    icon: Wallet,
    accent: 'from-emerald-500 to-teal-600',
    description: '日常收支记账',
    component: BookkeepingApp,
  },
]

/** 根据全局 apps 配置判断应用是否可见（未配置时默认显示） */
export function isAppVisible(app: AppDefinition, apps?: Record<string, { hidden: boolean }>): boolean {
  return !(apps?.[app.id]?.hidden)
}
