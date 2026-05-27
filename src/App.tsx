import { useState, useEffect } from 'react'
import { loadWebDAVConfig, saveWebDAVConfig } from '@/lib/config'
import SetupWizard from '@/components/SetupWizard'
import MainPage from '@/components/MainPage'
import OAuthCallback from '@/pages/OAuthCallback'

export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [isOAuthCallback, setIsOAuthCallback] = useState(false)

  useEffect(() => {
    // 检查是否是 OAuth 回调
    const hash = window.location.hash.substring(1)
    const hasAccessToken = hash.includes('access_token=') || hash.includes('token=')
    
    if (hasAccessToken) {
      console.log('[App] 检测到 OAuth 回调')
      setIsOAuthCallback(true)
      return
    }

    const wdav = loadWebDAVConfig()
    setConfigured(!!wdav)
  }, [])

  // OAuth 回调页面
  if (isOAuthCallback) {
    return <OAuthCallback />
  }

  // Loading state
  if (configured === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900">
        <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  if (!configured) {
    return (
      <SetupWizard
        onWebDAVSetup={(config) => {
          saveWebDAVConfig(config)
          setConfigured(true)
        }}
        onRemoteStorageSetup={() => {
          // RemoteStorage 模式不需要保存 WebDAV 配置
          setConfigured(true)
        }}
      />
    )
  }

  return <MainPage />
}
