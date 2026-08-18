import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from '@/lib/sw-register'
import versionInfo from '@/version.json'

// 打印版本和依赖包信息，便于调试
console.log(
  `[OneNav] version=${versionInfo.version} build=${versionInfo.buildTime}`,
  '\n[OneNav] packages:', versionInfo.depVersions || {},
)

// 尽早注册 Service Worker，使用 updateViaCache: 'none' 绕过 HTTP 缓存
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
