import { useState, useEffect } from 'react'
import { loadWebDAVConfig, saveWebDAVConfig } from '@/lib/config'
import SetupWizard from '@/components/SetupWizard'
import MainPage from '@/components/MainPage'

const RS_CONFIGURED_KEY = 'rsConfigured'

function isRSConfigured(): boolean {
  return localStorage.getItem(RS_CONFIGURED_KEY) === 'true'
}

function setRSConfigured(val: boolean): void {
  if (val) {
    localStorage.setItem(RS_CONFIGURED_KEY, 'true')
  } else {
    localStorage.removeItem(RS_CONFIGURED_KEY)
  }
}

export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    const wdav = loadWebDAVConfig()
    const rs = isRSConfigured()
    setConfigured(!!wdav || rs)
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
          setRSConfigured(true)
          setConfigured(true)
        }}
      />
    )
  }

  return <MainPage />
}
