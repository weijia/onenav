import { useState, useEffect } from 'react'
import { loadWebDAVConfig, saveWebDAVConfig } from '@/lib/config'
import SetupWizard from '@/components/SetupWizard'
import MainPage from '@/components/MainPage'

export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    const wdav = loadWebDAVConfig()
    setConfigured(!!wdav)
  }, [])

  if (configured === null) {
    // Loading state
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
          // 但 App 层面我们设置为已配置
          setConfigured(true)
        }}
      />
    )
  }

  return <MainPage />
}
