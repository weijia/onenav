import type { LucideIcon } from 'lucide-react'
import { Flag, Wallet } from 'lucide-react'

/**
 * 内置小应用的轻量元信息。
 * 注意：本清单【不含】页面组件，仅保留元数据，目的是让主 bundle（index.html）在加载时
 * 不会引入任何应用代码。每个应用的页面组件只被它自己的独立入口（apps/<id>/entry.tsx）import，
 * 这样主页面打开时不会一次性下载/执行所有小程序。
 */
export interface AppMeta {
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
  /** 该应用独立页面的相对路径（相对于主 index.html） */
  entry: string
}

/**
 * 内置应用清单。新增小应用时：
 *   1) 在此追加一项（仅元数据）；
 *   2) 在 apps/<id>/ 下放置 index.html + entry.tsx（entry 引入其页面组件）；
 *   3) vite.config.ts 已自动发现 apps 下各应用的 index.html 作为独立入口，无需手动注册。
 */
export const APP_MANIFEST: AppMeta[] = [
  {
    id: 'bookkeeping',
    name: '记账',
    icon: Wallet,
    accent: 'from-emerald-500 to-teal-600',
    description: '日常收支记账',
    entry: 'apps/bookkeeping/index.html',
  },
  {
    id: 'golf',
    name: '高尔夫球场地图',
    icon: Flag,
    accent: 'from-green-500 to-emerald-600',
    description: '球场地图与码数标注',
    entry: 'apps/golf/index.html',
  },
]

/** 根据全局 apps 配置判断应用是否可见（未配置时默认显示） */
export function isAppVisible(meta: AppMeta, apps?: Record<string, { hidden: boolean }>): boolean {
  return !(apps?.[meta.id]?.hidden)
}
