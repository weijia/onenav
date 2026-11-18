/**
 * 两个高尔夫页面共用的「数据同步组」面板。
 *
 * 用 zen-fs-config-ui 的 SyncGroupConfigurator 让用户配置 appId=golf 的同步后端；
 * 连上数据组后把 live 引用交给 golf-sync，驱动 golf 独立库的同步链路。
 */
import { useCallback, useEffect, useState } from 'react'
import { SyncGroupConfigurator } from 'zen-fs-config-ui/react'
import { registerGolfBackends, resolveGolfDataGroup } from '@/lib/golf-config-backends'
import { attachGolfDataGroup, detachGolfDataGroup, syncGolfNow, getGolfSyncError } from '@/lib/golf-sync'

export default function GolfSyncPanel() {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    registerGolfBackends()
    return () => detachGolfDataGroup()
  }, [])

  const onConnected = useCallback((data: any) => {
    resolveGolfDataGroup(data).then((group) => {
      if (!group) {
        setReady(false)
        setMessage('已连接配置仓，请创建 golf 数据同步组后重试')
        return
      }
      return attachGolfDataGroup(group).then(() => {
        setReady(true)
        setMessage('数据同步组已连接')
      })
    }).catch((e) => {
      setReady(false)
      setMessage(`连接失败：${String(e)}`)
    })
  }, [])

  const onError = useCallback((data: any) => setMessage(`配置错误：${data?.message ?? ''}`), [])

  const manualSync = useCallback(async () => {
    const ok = await syncGolfNow()
    setMessage(ok ? '同步完成' : `同步失败：${getGolfSyncError() ?? '数据组未连接'}`)
  }, [])

  return (
    <details className="rounded-lg bg-white/5 p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        数据同步组（appId: golf）{ready ? '· 已连接' : '· 未连接'}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs opacity-70">
          球场数据存独立库，经此同步组备份到 RemoteStorage；两个高尔夫页面共享同一份数据。
        </p>
        <div className="max-h-96 overflow-auto rounded bg-white/5 p-2">
          <SyncGroupConfigurator appId="golf" onConnected={onConnected} onError={onError} />
        </div>
        <button onClick={manualSync} disabled={!ready} className="rounded bg-emerald-600 px-3 py-1 disabled:opacity-40">
          立即同步
        </button>
        {message && <p className="text-xs opacity-80">{message}</p>}
      </div>
    </details>
  )
}
