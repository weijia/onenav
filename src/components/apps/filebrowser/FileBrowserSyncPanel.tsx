/**
 * 文件浏览器「数据同步组」面板。
 *
 * 用 zen-fs-config-ui 的 SyncGroupConfigurator 配置 appId=dir-struct-gen 的同步后端，
 * 与 zip-browser / dir-struct-gen 写侧共用同一数据组；连上数据组后把 live 引用
 * 交给 dir-struct-group 持有，文件浏览器读侧从该组 fs 读清单。
 *
 * 注意：config-sync 模式下数据组是在「添加后端 / 新建数据组」之后才实例化的，
 * 这两个动作只触发 backend-added / data-group-created，不会再发 connected；
 * 因此这两个事件后要重新从 core 快照解析数据组，否则读侧一直判未连接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
  // 未就绪时默认展开，避免配置入口被折叠、被下方错误提示挤到看不到。
  const [open, setOpen] = useState(true)
  const coreRef = useRef<{ getConnection?: () => any } | null>(null)

  useEffect(() => {
    registerFsConfigBackends()
    return () => detachDirStructGroup()
  }, [])

  // 从 core 快照或事件 payload 解析数据组并 attach；成功后回调刷新清单。
  const resolveFrom = useCallback(
    async (detail: any) => {
      const conn = detail ?? coreRef.current?.getConnection?.()
      const group = await resolveDataGroup(conn, DIR_STRUCT_APP_ID)
      if (!group) {
        attachDirStructGroup(null)
        setReady(false)
        setMessage('已连接配置仓，请创建/选择含远端后端的数据同步组后重试')
        return
      }
      attachDirStructGroup(group)
      setReady(true)
      setMessage('数据同步组已连接')
      onReady?.()
    },
    [onReady],
  )

  const onConnected = useCallback(
    (data: any) => {
      resolveFrom(data).catch((e) => {
        attachDirStructGroup(null)
        setReady(false)
        setMessage(`连接失败：${String(e)}`)
      })
    },
    [resolveFrom],
  )

  // 添加后端 / 新建数据组后，数据组才实例化；重新解析并刷新，不必等整页重载。
  const onBackendAdded = useCallback(() => {
    void resolveFrom(undefined)
  }, [resolveFrom])

  const onDataGroupCreated = useCallback((data: any) => {
    // 新建事件直接带了 dataGroup，优先用它；否则走 core 快照。
    void resolveFrom(data)
  }, [resolveFrom])

  const onError = useCallback((data: any) => setMessage(`配置错误：${data?.message ?? ''}`), [])

  return (
    <details
      className="rounded-lg bg-white/5 p-3 text-sm"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
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
            onCoreReady={(core) => {
              coreRef.current = core
            }}
            onConnected={onConnected}
            onBackendAdded={onBackendAdded}
            onDataGroupCreated={onDataGroupCreated}
            onError={onError}
          />
        </div>
        {message && <p className="text-xs opacity-80">{message}</p>}
      </div>
    </details>
  )
}
