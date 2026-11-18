/**
 * 文件浏览器「数据同步组」面板。
 *
 * 用 zen-fs-config-ui 的 SyncGroupConfigurator 配置 appId=dir-struct-gen 的同步后端，
 * 与 zip-browser / dir-struct-gen 写侧共用同一数据组；连上数据组后把 live 引用
 * 交给 dir-struct-group 持有，文件浏览器读侧从该组 fs 读清单。
 */
import { useCallback, useEffect, useState } from 'react'
import { SyncGroupConfigurator } from 'zen-fs-config-ui/react'
import { registerFsConfigBackends, resolveDataGroup } from '@/lib/fs-config-backends'
import {
  attachDirStructGroup,
  detachDirStructGroup,
  DIR_STRUCT_APP_ID,
} from '@/lib/dir-struct-group'

export default function FileBrowserSyncPanel({ onReady }: { onReady?: () => void }) {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    registerFsConfigBackends()
    return () => detachDirStructGroup()
  }, [])

  const onConnected = useCallback(
    (data: any) => {
      resolveDataGroup(data, DIR_STRUCT_APP_ID)
        .then((group) => {
          if (!group) {
            attachDirStructGroup(null)
            setReady(false)
            setMessage('已连接配置仓，请创建数据同步组后重试')
            return
          }
          attachDirStructGroup(group)
          setReady(true)
          setMessage('数据同步组已连接')
          onReady?.()
        })
        .catch((e) => {
          attachDirStructGroup(null)
          setReady(false)
          setMessage(`连接失败：${String(e)}`)
        })
    },
    [onReady],
  )

  const onError = useCallback((data: any) => setMessage(`配置错误：${data?.message ?? ''}`), [])

  return (
    <details className="rounded-lg bg-white/5 p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        数据同步组（appId: {DIR_STRUCT_APP_ID}）{ready ? '· 已连接' : '· 未连接'}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs opacity-70">
          目录清单与标签存于此同步组；后端地址 / token / 基准路径在下方配置，与生成端共用同一组数据。
        </p>
        <div className="max-h-96 overflow-auto rounded bg-white/5 p-2">
          <SyncGroupConfigurator
            appId={DIR_STRUCT_APP_ID}
            onConnected={onConnected}
            onError={onError}
          />
        </div>
        {message && <p className="text-xs opacity-80">{message}</p>}
      </div>
    </details>
  )
}
