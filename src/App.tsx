import { useState, useEffect } from 'react'
import { loadWebDAVConfig, saveWebDAVConfig } from '@/lib/config'
import SetupWizard from '@/components/SetupWizard'
import MainPage from '@/components/MainPage'
import { onStatusChange } from '@/lib/remotestorage-connection'

export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    // 检查是否是首次访问或已有 WebDAV 配置
    const wdav = loadWebDAVConfig()
    setConfigured(!!wdav)

    // 监听 RemoteStorage 连接状态
    // 如果 URL 中有 access_token，RemoteStorage 会自动处理
    const unsubscribe = onStatusChange((info) => {
      if (info.status === 'connected') {
        console.log('[App] RemoteStorage 已连接')
      }
    })

    return unsubscribe
  }, [])

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
          // RemoteStorage 模式：标记为已配置
          // RemoteStorage 的连接状态由组件内部管理
          setConfigured(true)
        }}
      />
    )
  }

  return <MainPage />
}
