import { useState, useCallback } from 'react'
import { Cloud, CloudOff, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'
import { syncToRemoteStorage, type RemoteStorageConnectionConfig } from '@/lib/remotestorage-sync'

interface RemoteStorageSyncProps {
  db: PouchDB.Database | null
}

export default function RemoteStorageSync({ db }: RemoteStorageSyncProps) {
  const [config, setConfig] = useState<RemoteStorageConnectionConfig>({
    href: '',
    token: '',
    basePath: '/public/onenav/',
    timeout: 30000,
  })
  const [syncing, setSyncing] = useState(false)
  const [lastResult, setLastResult] = useState<{ success: boolean; message: string } | null>(null)
  const [showConfig, setShowConfig] = useState(false)

  const handleSync = useCallback(async () => {
    if (!db || syncing) return

    if (!config.href || !config.token) {
      setLastResult({ success: false, message: '请先配置 RemoteStorage 连接信息' })
      setShowConfig(true)
      return
    }

    setSyncing(true)
    setLastResult(null)

    try {
      await syncToRemoteStorage(db, config, {
        maxFileSize: 500 * 1024,
        autoMerge: true,
      })
      setLastResult({ success: true, message: '同步成功！数据已保存到 RemoteStorage' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失败'
      setLastResult({ success: false, message })
    } finally {
      setSyncing(false)
    }
  }, [db, config, syncing])

  return (
    <div className="bg-white/10 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {config.href && config.token ? (
            <Cloud className="w-5 h-5 text-green-400" />
          ) : (
            <CloudOff className="w-5 h-5 text-white/40" />
          )}
          <span className="text-white font-medium">RemoteStorage 同步</span>
        </div>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="text-sm text-white/60 hover:text-white transition-colors"
        >
          {showConfig ? '隐藏配置' : '配置'}
        </button>
      </div>

      {showConfig && (
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-white/60 mb-1">RemoteStorage URL</label>
            <input
              type="url"
              value={config.href}
              onChange={(e) => setConfig({ ...config, href: e.target.value })}
              placeholder="https://storage.5apps.com"
              className="w-full px-3 py-2 rounded bg-white/10 border border-white/20 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40"
            />
          </div>
          <div>
            <label className="block text-sm text-white/60 mb-1">Bearer Token</label>
            <input
              type="password"
              value={config.token}
              onChange={(e) => setConfig({ ...config, token: e.target.value })}
              placeholder="your-token-here"
              className="w-full px-3 py-2 rounded bg-white/10 border border-white/20 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40"
            />
          </div>
          <div>
            <label className="block text-sm text-white/60 mb-1">Base Path</label>
            <input
              type="text"
              value={config.basePath}
              onChange={(e) => setConfig({ ...config, basePath: e.target.value })}
              placeholder="/public/onenav/"
              className="w-full px-3 py-2 rounded bg-white/10 border border-white/20 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40"
            />
          </div>
        </div>
      )}

      <button
        onClick={handleSync}
        disabled={!db || syncing}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-white/10 disabled:cursor-not-allowed text-white font-medium transition-colors"
      >
        {syncing ? (
          <>
            <RefreshCw className="w-4 h-4 animate-spin" />
            同步中...
          </>
        ) : (
          <>
            <Cloud className="w-4 h-4" />
            同步到 RemoteStorage
          </>
        )}
      </button>

      {lastResult && (
        <div
          className={`flex items-center gap-2 text-sm ${
            lastResult.success ? 'text-green-400' : 'text-red-400'
          }`}
        >
          {lastResult.success ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {lastResult.message}
        </div>
      )}
    </div>
  )
}
