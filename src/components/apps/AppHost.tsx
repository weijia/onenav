import { useEffect } from 'react'
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeft } from 'lucide-react'
import { versionDisplay, buildTimeDisplay } from '@/lib/version'
import { registerServiceWorker } from '@/lib/sw-register'
import { bootstrapAppRemoteStorage } from '@/lib/app-host-sync'
import UpdateToast from '@/components/UpdateToast'
import UpdateCheckButton from '@/components/UpdateCheckButton'
import SyncStatusChip from '@/components/apps/SyncStatusChip'

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
  /** 配色主题：dark=深色底（默认），light=浅色底 */
  theme?: 'dark' | 'light'
}

/**
 * 内置应用的独立页面容器：顶部返回栏 + 应用页面主体。
 * 这是一个纯展示组件——页面组件由各应用入口（apps/<id>/entry.tsx）直接传入，
 * 从而保持主 bundle 不含任何应用代码。
 *
 * 所有独立应用页（apps/<id>/index.html，位于仓库两级深度）共用本容器，
 * 因此在这里统一做三件「主页已有」的事：
 *  1. 注册根目录 Service Worker（路径 ../../sw.js，作用域覆盖全站）——离线可用 + 可检测新版本；
 *  2. 渲染 UpdateToast——与主页一致的「新版本可用 / 点击刷新」提示与重载；
 *  3. 后台引导 RemoteStorage 连接与初始同步，并渲染统一的同步进度胶囊（SyncStatusChip）。
 *
 * 关键设计：**不再用 rsReady 门控应用主体**。应用一律立即挂载、先用本地缓存数据打开；
 * 连接后端与初始同步在后台进行，进度写在全局同步状态 store，由 SyncStatusChip 展示；
 * 同步结束后 bootstrapAppRemoteStorage 会派发 RS_SYNCED_EVENT，应用重读本地库后显示更新内容。
 * 这样冷启动连组 + 首轮同步再慢也不会把页面卡在「正在连接 RemoteStorage…」上。
 */
export default function AppHost({ name, description, accent, icon: Icon, component: AppComp, onBack, theme = 'dark' }: AppHostProps) {
  const light = theme === 'light'
  // 注册根 SW：../../sw.js 相对 apps/<id>/index.html 解析到根目录，作用域覆盖全站。
  // 幂等——若主页或其他应用页已注册同一 SW，浏览器返回同一 registration。
  useEffect(() => {
    registerServiceWorker('../../sw.js')
  }, [])

  // 独立应用页的 RemoteStorage 同步引导：建立连接 + 一次初始双向同步。
  // 不阻塞渲染：应用主体已在下方立即挂载；同步进度由 SyncStatusChip 订阅全局状态展示，
  // 同步结束后 app-host-sync 派发 RS_SYNCED_EVENT，需要刷新的应用自行监听。
  // 无凭据时立即返回，不阻塞本地模式。
  useEffect(() => {
    void bootstrapAppRemoteStorage()
  }, [])

  return (
    <div className={`w-full h-full flex flex-col ${light ? 'text-slate-800' : ''}`}>
      <div className={`flex items-center gap-3 px-4 py-3 border-b shrink-0 ${light ? 'border-slate-200 bg-white/70' : 'border-white/10'}`}>
        <button
          onClick={onBack}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
            light ? 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/70' : 'text-white/60 hover:text-white hover:bg-white/10'
          }`}
          title="返回书签"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${accent} flex items-center justify-center`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className={`font-medium leading-tight ${light ? 'text-slate-800' : 'text-white/90'}`}>{name}</h2>
          <p className={`text-xs ${light ? 'text-slate-500' : 'text-white/40'}`}>{description}</p>
        </div>
        {/* 每个独立应用页都有「强制检查更新」：站点根 version.json + SW 双通道，不依赖 sw.js 定时检查 */}
        <UpdateCheckButton className="ml-auto" theme={theme} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <AppComp />
      </div>
      <div className={`text-center py-2 text-xs shrink-0 flex items-center justify-center gap-2 ${light ? 'text-slate-400' : 'text-white/20'}`}>
        <span>{versionDisplay}</span>
        <span>·</span>
        <span>{buildTimeDisplay}</span>
      </div>
      {/* 统一的同步进度胶囊：所有独立应用页共享，避免各应用各写一份 */}
      <SyncStatusChip />
      {/* 与主页一致的版本更新提示（新版本可用 → 点击刷新 → SKIP_WAITING + 重载） */}
      <UpdateToast />
    </div>
  )
}
