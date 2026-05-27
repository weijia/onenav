import { useState, useEffect, useCallback } from 'react'
import {
  Cloud,
  CloudOff,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  LogIn,
  LogOut,
  Loader2,
  Key,
} from 'lucide-react'
import {
  connectWithUserAddress,
  connectWithToken,
  disconnect,
  onStatusChange,
  getStorageCredentials,
  claimAccess,
  type RSConnectionInfo,
} from '@/lib/remotestorage-connection'
import { syncToRemoteStorage, type RemoteStorageConnectionConfig } from '@/lib/remotestorage-sync'

interface RemoteStorageSyncProps {
  db: PouchDB.Database | null
}

type LoginMode = 'widget' | 'manual'

export default function RemoteStorageSync({ db }: RemoteStorageSyncProps) {
  const [connectionInfo, setConnectionInfo] = useState<RSConnectionInfo>({ status: 'disconnected' })
  const [userAddress, setUserAddress] = useState('')
  const [loginMode, setLoginMode] = useState<LoginMode>('widget')
  const [manualToken, setManualToken] = useState('')
  const [manualHref, setManualHref] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [lastResult, setLastResult] = useState<{ success: boolean; message: string } | null>(null)

  // 声明访问权限
  useEffect(() => {
    claimAccess('onenav', 'rw')
  }, [])

  // 监听连接状态
  useEffect(() => {
    const unsubscribe = onStatusChange(setConnectionInfo)
    return unsubscribe
  }, [])

  // Widget 模式登录
  const handleWidgetConnect = useCallback(() => {
    if (!userAddress.trim()) return
    setLastResult(null)
    connectWithUserAddress(userAddress.trim())
  }, [userAddress])

  // 手动模式登录
  const handleManualConnect = useCallback(() => {
    if (!manualHref.trim() || !manualToken.trim()) return
    setLastResult(null)
    connectWithToken(manualHref.trim(), manualToken.trim())
  }, [manualHref, manualToken])

  // 断开连接
  const handleDisconnect = useCallback(() => {
    disconnect()
    setLastResult(null)
  }, [])

  // 同步
  const handleSync = useCallback(async () => {
    if (!db || syncing) return

    const credentials = getStorageCredentials()
    if (!credentials) {
      setLastResult({ success: false, message: '请先连接 RemoteStorage' })
      return
    }

    setSyncing(true)
    setLastResult(null)

    try {
      const config: RemoteStorageConnectionConfig = {
        href: credentials.href,
        token: credentials.token,
      }
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
  }, [db, syncing])

  const isConnected = connectionInfo.status === 'connected'
  const isConnecting = connectionInfo.status === 'connecting' || connectionInfo.status === 'authing'

  return (
    <div className="space-y-4">
      {/* 连接状态卡片 */}
      <div className={`rounded-lg p-3 flex items-center gap-3 ${
        isConnected ? 'bg-green-500/10 border border-green-500/30' :
        isConnecting ? 'bg-yellow-500/10 border border-yellow-500/30' :
        connectionInfo.status === 'error' ? 'bg-red-500/10 border border-red-500/30' :
        'bg-white/5 border border-white/10'
      }`}>
        {isConnected ? (
          <Cloud className="w-5 h-5 text-green-400 shrink-0" />
        ) : isConnecting ? (
          <Loader2 className="w-5 h-5 text-yellow-400 animate-spin shrink-0" />
        ) : connectionInfo.status === 'error' ? (
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
        ) : (
          <CloudOff className="w-5 h-5 text-white/40 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          {isConnected ? (
            <div>
              <p className="text-sm text-green-300 font-medium">已连接</p>
              <p className="text-xs text-white/50 truncate">{connectionInfo.userAddress}</p>
            </div>
          ) : isConnecting ? (
            <div>
              <p className="text-sm text-yellow-300 font-medium">
                {connectionInfo.status === 'connecting' ? '正在发现存储...' : '正在授权...'}
              </p>
              <p className="text-xs text-white/50">请在新窗口中完成授权</p>
            </div>
          ) : connectionInfo.status === 'error' ? (
            <div>
              <p className="text-sm text-red-300 font-medium">连接失败</p>
              <p className="text-xs text-white/50 truncate">{connectionInfo.error}</p>
            </div>
          ) : (
            <p className="text-sm text-white/50">未连接 RemoteStorage</p>
          )}
        </div>
        {isConnected && (
          <button
            onClick={handleDisconnect}
            className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-red-400 transition-colors"
            title="断开连接"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 未连接时显示登录表单 */}
      {!isConnected && !isConnecting && (
        <div className="space-y-3">
          {/* 登录模式切换 */}
          <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
            <button
              onClick={() => setLoginMode('widget')}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                loginMode === 'widget'
                  ? 'bg-white/15 text-white'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              <LogIn className="w-3 h-3 inline mr-1" />
              账号登录
            </button>
            <button
              onClick={() => setLoginMode('manual')}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                loginMode === 'manual'
                  ? 'bg-white/15 text-white'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              <Key className="w-3 h-3 inline mr-1" />
              手动输入
            </button>
          </div>

          {loginMode === 'widget' ? (
            /* Widget 模式：输入 user@host 地址 */
            <div className="space-y-2">
              <p className="text-xs text-white/40">
                输入你的 RemoteStorage 用户地址（如 user@5apps.com），将通过 OAuth 授权登录。
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={userAddress}
                  onChange={(e) => setUserAddress(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleWidgetConnect()}
                  placeholder="user@storage.example.com"
                  className="flex-1 px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
                />
                <button
                  onClick={handleWidgetConnect}
                  disabled={!userAddress.trim()}
                  className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-white/10 disabled:text-white/30 text-white text-sm font-medium transition-colors"
                >
                  连接
                </button>
              </div>
            </div>
          ) : (
            /* 手动模式：输入 href 和 token */
            <div className="space-y-2">
              <p className="text-xs text-white/40">
                直接输入 RemoteStorage 的存储地址和 Bearer Token。
              </p>
              <input
                type="url"
                value={manualHref}
                onChange={(e) => setManualHref(e.target.value)}
                placeholder="https://storage.example.com"
                className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
              />
              <input
                type="password"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="Bearer Token"
                className="w-full px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
              />
              <button
                onClick={handleManualConnect}
                disabled={!manualHref.trim() || !manualToken.trim()}
                className="w-full px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-white/10 disabled:text-white/30 text-white text-sm font-medium transition-colors"
              >
                连接
              </button>
            </div>
          )}
        </div>
      )}

      {/* 同步按钮 */}
      {isConnected && (
        <button
          onClick={handleSync}
          disabled={!db || syncing}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-white/10 disabled:cursor-not-allowed text-white font-medium transition-colors"
        >
          {syncing ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              同步中...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4" />
              同步到 RemoteStorage
            </>
          )}
        </button>
      )}

      {/* 结果反馈 */}
      {lastResult && (
        <div
          className={`flex items-center gap-2 text-sm ${
            lastResult.success ? 'text-green-400' : 'text-red-400'
          }`}
        >
          {lastResult.success ? (
            <CheckCircle className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          {lastResult.message}
        </div>
      )}
    </div>
  )
}
