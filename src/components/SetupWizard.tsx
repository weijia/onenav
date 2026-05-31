import { useState, useEffect, useCallback } from 'react'
import { Cloud, FolderOpen, ArrowRight, Loader2, CheckCircle, AlertCircle, Globe } from 'lucide-react'
import {
  connectWithUserAddress,
  connectWithToken,
  onStatusChange,
  getStorageCredentials,
  getConnectionInfo,
  claimAccess,
  type RSConnectionInfo,
} from '@/lib/remotestorage-connection'
import { syncToRemoteStorage } from '@/lib/remotestorage-sync'
import { loadFromRemoteStorage, hasRemoteStorageData } from '@/lib/remotestorage-load'
import { getPouchDB } from '@/lib/pouchdb'

type SetupMode = 'choose' | 'webdav' | 'remotestorage'
type RSLoginMode = 'widget' | 'manual'

interface SetupWizardProps {
  onWebDAVSetup: (config: { url: string; username: string; password: string }) => void
  onRemoteStorageSetup: (credentials: { href: string; token: string }) => void
}

export default function SetupWizard({ onWebDAVSetup, onRemoteStorageSetup }: SetupWizardProps) {
  const [mode, setMode] = useState<SetupMode>('choose')
  const [rsConnectionInfo, setRsConnectionInfo] = useState<RSConnectionInfo>({ status: 'disconnected' })
  const [rsLoginMode, setRsLoginMode] = useState<RSLoginMode>('widget')
  const [rsUserAddress, setRsUserAddress] = useState('')
  const [rsManualHref, setRsManualHref] = useState('')
  const [rsManualToken, setRsManualToken] = useState('')
  const [rsSyncing, setRsSyncing] = useState(false)
  const [hasAutoEntered, setHasAutoEntered] = useState(false)

  // WebDAV 表单
  const [wdavUrl, setWdavUrl] = useState('')
  const [wdavUsername, setWdavUsername] = useState('')
  const [wdavPassword, setWdavPassword] = useState('')

  // RemoteStorage 连接状态监听
  const startRSMonitor = useCallback(() => {
    claimAccess('onenav', 'rw')
    return onStatusChange(setRsConnectionInfo)
  }, [])

  // 检测 OAuth 回调（URL 中有 access_token）或已保存的凭证，自动开始监听
  useEffect(() => {
    const hasCallback = window.location.hash.includes('access_token')
    const savedCreds = localStorage.getItem('onenav:rs-credentials')
    if (hasCallback || savedCreds) {
      console.log('[SetupWizard] 检测到 OAuth 回调或已保存凭证，自动开始监听')
      startRSMonitor()
      if (hasCallback) {
        setMode('remotestorage')
      }
      // remotestoragejs 处理 OAuth 回调是异步的，延迟检查连接状态
      const timer = setTimeout(() => {
        console.log('[SetupWizard] 延迟检查连接状态...')
        const info = getConnectionInfo()
        console.log('[SetupWizard] 延迟检查结果:', info)
        if (info.status === 'connected') {
          setRsConnectionInfo(info)
        }
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [startRSMonitor])

  // 监听 RemoteStorage 连接状态，自动进入应用
  useEffect(() => {
    const handleAutoEnter = async () => {
      if (rsConnectionInfo.status === 'connected' && !hasAutoEntered && !rsSyncing) {
        console.log('[SetupWizard] RemoteStorage 连接成功，准备自动进入...')
        
        const credentials = getStorageCredentials()
        if (!credentials) {
          console.log('[SetupWizard] 等待 credentials...')
          return
        }

        setHasAutoEntered(true)
        setRsSyncing(true)
        
        try {
          const db = await getPouchDB()
          
          // 检查 RemoteStorage 是否有数据
          const rsHasData = await hasRemoteStorageData(db, credentials)
          
          if (rsHasData) {
            // 从 RemoteStorage 加载数据到 PouchDB
            const result = await loadFromRemoteStorage(db, credentials)
            console.log('从 RemoteStorage 加载完成', result.errors.length > 0 ? result.errors : '')
          } else {
            // RemoteStorage 没有数据，将本地 PouchDB 数据同步上去
            console.log('RemoteStorage 没有数据，执行首次同步...')
            await syncToRemoteStorage(db, credentials, {
              maxFileSize: 500 * 1024,
              autoMerge: true,
            })
          }
          
          // 清理 URL 中的 hash
          if (window.location.hash) {
            history.replaceState(null, '', window.location.pathname)
          }
          
          onRemoteStorageSetup(credentials)
        } catch (err) {
          console.error('RemoteStorage 初始化失败:', err)
          onRemoteStorageSetup(credentials)
        } finally {
          setRsSyncing(false)
        }
      }
    }
    
    handleAutoEnter()
  }, [rsConnectionInfo.status, hasAutoEntered, rsSyncing, onRemoteStorageSetup])

  // RemoteStorage Widget 登录
  const handleRSWidgetConnect = useCallback(() => {
    if (!rsUserAddress.trim()) return
    startRSMonitor()
    connectWithUserAddress(rsUserAddress.trim())
  }, [rsUserAddress, startRSMonitor])

  // RemoteStorage 手动登录
  const handleRSManualConnect = useCallback(() => {
    if (!rsManualHref.trim() || !rsManualToken.trim()) return
    startRSMonitor()
    connectWithToken(rsManualHref.trim(), rsManualToken.trim())
  }, [rsManualHref, rsManualToken, startRSMonitor])

  // WebDAV 提交
  const handleWebDAVSubmit = useCallback(() => {
    if (!wdavUrl.trim()) return
    onWebDAVSetup({
      url: wdavUrl.trim(),
      username: wdavUsername.trim(),
      password: wdavPassword,
    })
  }, [wdavUrl, wdavUsername, wdavPassword, onWebDAVSetup])

  const rsConnected = rsConnectionInfo.status === 'connected'
  const rsConnecting = rsConnectionInfo.status === 'connecting' || rsConnectionInfo.status === 'authing'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 p-4">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-white/10 flex items-center justify-center mx-auto mb-4">
            <Globe className="w-8 h-8 text-white/80" />
          </div>
          <h1 className="text-2xl font-bold text-white">OneNav</h1>
          <p className="text-white/50 text-sm mt-1">选择数据源来初始化</p>
        </div>

        {/* 选择模式 */}
        {mode === 'choose' && (
          <div className="space-y-3">
            <button
              onClick={() => setMode('webdav')}
              className="w-full p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                  <FolderOpen className="w-6 h-6 text-blue-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-white font-medium">WebDAV</h3>
                  <p className="text-white/40 text-sm">连接 WebDAV 服务器加载书签数据</p>
                </div>
                <ArrowRight className="w-5 h-5 text-white/20 group-hover:text-white/50 transition-colors" />
              </div>
            </button>

            <button
              onClick={() => {
                setMode('remotestorage')
                startRSMonitor()
              }}
              className="w-full p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center shrink-0">
                  <Cloud className="w-6 h-6 text-green-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-white font-medium">RemoteStorage</h3>
                  <p className="text-white/40 text-sm">使用 RemoteStorage 账号同步数据</p>
                </div>
                <ArrowRight className="w-5 h-5 text-white/20 group-hover:text-white/50 transition-colors" />
              </div>
            </button>
          </div>
        )}

        {/* WebDAV 配置 */}
        {mode === 'webdav' && (
          <div className="rounded-xl bg-white/5 border border-white/10 p-6 space-y-4">
            <button
              onClick={() => setMode('choose')}
              className="text-white/40 hover:text-white/70 text-sm transition-colors"
            >
              ← 返回
            </button>
            <h2 className="text-lg font-medium text-white">WebDAV 配置</h2>
            <div>
              <label className="block text-sm text-white/50 mb-1">服务器地址</label>
              <input
                type="url"
                value={wdavUrl}
                onChange={(e) => setWdavUrl(e.target.value)}
                placeholder="https://dav.example.com"
                className="w-full px-3 py-2.5 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-white/50 mb-1">用户名</label>
              <input
                type="text"
                value={wdavUsername}
                onChange={(e) => setWdavUsername(e.target.value)}
                placeholder="username"
                className="w-full px-3 py-2.5 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40"
              />
            </div>
            <div>
              <label className="block text-sm text-white/50 mb-1">密码</label>
              <input
                type="password"
                value={wdavPassword}
                onChange={(e) => setWdavPassword(e.target.value)}
                placeholder="password"
                onKeyDown={(e) => e.key === 'Enter' && handleWebDAVSubmit()}
                className="w-full px-3 py-2.5 rounded-lg bg-white/10 border border-white/20 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40"
              />
            </div>
            <button
              onClick={handleWebDAVSubmit}
              disabled={!wdavUrl.trim()}
              className="w-full py-2.5 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-white/10 disabled:text-white/30 text-white font-medium transition-colors"
            >
              连接
            </button>
          </div>
        )}

        {/* RemoteStorage 配置 */}
        {mode === 'remotestorage' && (
          <div className="rounded-xl bg-white/5 border border-white/10 p-6 space-y-4">
            <button
              onClick={() => setMode('choose')}
              className="text-white/40 hover:text-white/70 text-sm transition-colors"
            >
              ← 返回
            </button>
            <h2 className="text-lg font-medium text-white">RemoteStorage</h2>

            {/* 连接状态 */}
            <div className={`rounded-lg p-3 flex items-center gap-3 ${
              rsConnected ? 'bg-green-500/10 border border-green-500/30' :
              rsConnecting ? 'bg-yellow-500/10 border border-yellow-500/30' :
              rsConnectionInfo.status === 'error' ? 'bg-red-500/10 border border-red-500/30' :
              'bg-white/5 border border-white/10'
            }`}>
              {rsConnected ? (
                <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
              ) : rsConnecting ? (
                <Loader2 className="w-5 h-5 text-yellow-400 animate-spin shrink-0" />
              ) : rsConnectionInfo.status === 'error' ? (
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
              ) : (
                <Cloud className="w-5 h-5 text-white/40 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                {rsConnected ? (
                  <p className="text-sm text-green-300">已连接 · {rsConnectionInfo.userAddress}</p>
                ) : rsConnecting ? (
                  <p className="text-sm text-yellow-300">
                    {rsConnectionInfo.status === 'connecting' ? '正在发现存储...' : '正在授权...'}
                  </p>
                ) : rsConnectionInfo.status === 'error' ? (
                  <p className="text-sm text-red-300 truncate">{rsConnectionInfo.error}</p>
                ) : (
                  <p className="text-sm text-white/50">未连接</p>
                )}
              </div>
            </div>

            {/* 同步状态 */}
            {rsSyncing && (
              <div className="rounded-lg p-3 bg-blue-500/10 border border-blue-500/30 flex items-center gap-3">
                <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                <p className="text-sm text-blue-300">正在加载数据...</p>
              </div>
            )}

            {/* 登录表单（未连接时显示） */}
            {!rsConnected && !rsConnecting && !rsSyncing && (
              <>
                {/* 登录模式切换 */}
                <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                  <button
                    onClick={() => setRsLoginMode('widget')}
                    className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      rsLoginMode === 'widget' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/70'
                    }`}
                  >
                    账号登录
                  </button>
                  <button
                    onClick={() => setRsLoginMode('manual')}
                    className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      rsLoginMode === 'manual' ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/70'
                    }`}
                  >
                    手动输入
                  </button>
                </div>

                {rsLoginMode === 'widget' ? (
                  <div className="space-y-2">
                    <p className="text-xs text-white/40">输入你的 RemoteStorage 用户地址</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={rsUserAddress}
                        onChange={(e) => setRsUserAddress(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleRSWidgetConnect()}
                        placeholder="user@storage.example.com"
                        className="flex-1 px-3 py-2.5 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
                        autoFocus
                      />
                      <button
                        onClick={handleRSWidgetConnect}
                        disabled={!rsUserAddress.trim()}
                        className="px-4 py-2.5 rounded-lg bg-green-500 hover:bg-green-600 disabled:bg-white/10 disabled:text-white/30 text-white text-sm font-medium transition-colors"
                      >
                        连接
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="url"
                      value={rsManualHref}
                      onChange={(e) => setRsManualHref(e.target.value)}
                      placeholder="https://storage.example.com"
                      className="w-full px-3 py-2.5 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
                    />
                    <input
                      type="password"
                      value={rsManualToken}
                      onChange={(e) => setRsManualToken(e.target.value)}
                      placeholder="Bearer Token"
                      onKeyDown={(e) => e.key === 'Enter' && handleRSManualConnect()}
                      className="w-full px-3 py-2.5 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-white/40"
                    />
                    <button
                      onClick={handleRSManualConnect}
                      disabled={!rsManualHref.trim() || !rsManualToken.trim()}
                      className="w-full py-2.5 rounded-lg bg-green-500 hover:bg-green-600 disabled:bg-white/10 disabled:text-white/30 text-white text-sm font-medium transition-colors"
                    >
                      连接
                    </button>
                  </div>
                )}
              </>
            )}

            {/* 连接成功后自动进入 */}
            {rsConnected && !rsSyncing && (
              <div className="flex items-center gap-2 text-green-300 text-sm">
                <CheckCircle className="w-4 h-4" />
                连接成功，正在加载数据...
              </div>
            )}
          </div>
        )}
        {/* 版本信息 */}
        <div className="text-center mt-6">
          <p className="text-white/20 text-xs">v{__APP_VERSION__} · {new Date().getFullYear()}</p>
        </div>
      </div>
    </div>
  )
}
