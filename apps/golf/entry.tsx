import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import AppHost from '@/components/apps/AppHost'
import GolfApp from '@/components/apps/golf/GolfApp'
import { APP_MANIFEST } from '@/components/apps/manifest'

const meta = APP_MANIFEST.find((m) => m.id === 'golf')!

// 根目录 Service Worker 的注册已收敛到 AppHost（所有独立应用页共用）：
// 路径 ../../sw.js 相对本页（apps/golf/index.html）解析到根目录，作用域随之覆盖全站，
// 使本页在断网时也能打开，并具备与主页一致的「新版本可用」更新提示。

// 返回书签区：优先用浏览器后退（从首页点链接进来），无历史时回首页。
function goBack() {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    // 本文件位于 apps/golf/index.html，上两级即根目录的首页
    location.href = '../../index.html'
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 独立页面自带深色背景（与主程序默认渐变一致），不依赖主程序的背景配置 */}
    <div className="fixed inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <AppHost
        name={meta.name}
        description={meta.description}
        accent={meta.accent}
        icon={meta.icon}
        component={GolfApp}
        onBack={goBack}
      />
    </div>
  </StrictMode>,
)
