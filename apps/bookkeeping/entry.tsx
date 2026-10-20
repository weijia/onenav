import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import AppHost from '@/components/apps/AppHost'
import BookkeepingApp from '@/components/apps/BookkeepingApp'
import { APP_MANIFEST } from '@/components/apps/manifest'

const meta = APP_MANIFEST.find((m) => m.id === 'bookkeeping')!

// 返回书签区：优先用浏览器后退（从首页点链接进来），无历史时回首页。
function goBack() {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    // 本文件位于 apps/bookkeeping/index.html，上两级即根目录的首页
    location.href = '../../index.html'
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 独立页面自带深色背景（与主程序默认渐变一致），不依赖主程序的背景配置 */}
    <div className="fixed inset-0 bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 overflow-auto">
      <AppHost
        name={meta.name}
        description={meta.description}
        accent={meta.accent}
        icon={meta.icon}
        component={BookkeepingApp}
        onBack={goBack}
      />
    </div>
  </StrictMode>,
)
