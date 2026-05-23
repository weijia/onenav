import { useState, useEffect } from 'react'
import { loadWebDAVConfig } from '@/lib/config'
import SetupPage from '@/components/SetupPage'
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
    return <SetupPage onConfigured={() => setConfigured(true)} />
  }

  return <MainPage />
}
