import { ArrowLeft } from 'lucide-react'
import { APP_REGISTRY } from './registry'

interface AppHostProps {
  appId: string
  onBack: () => void
}

/** 内置应用的独立页面容器：顶部返回栏 + 应用页面主体 */
export default function AppHost({ appId, onBack }: AppHostProps) {
  const def = APP_REGISTRY.find((a) => a.id === appId)

  if (!def) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-white/60 gap-4">
        <p>未找到应用：{appId}</p>
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white"
        >
          返回
        </button>
      </div>
    )
  }

  const AppComp = def.component
  const Icon = def.icon

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
        <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${def.accent} flex items-center justify-center`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-white/90 font-medium leading-tight">{def.name}</h2>
          <p className="text-white/40 text-xs">{def.description}</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <AppComp />
      </div>
    </div>
  )
}
