/**
 * 点菜助手「数据同步组」面板。
 * 用 zen-fs-config-ui 的 SyncGroupConfigurator 配置 appId=dish-order 的同步后端；
 * 连上后把 live 数据组引用交给 store，页面即可按月份读写点菜记录。
 *
 * 与文件浏览器一致：添加后端 / 新建数据组后数据组才实例化，这两个事件后
 * 要重新从 core 快照解析，否则读侧一直判未连接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { SyncGroupConfigurator } from 'zen-fs-config-ui/react'
import { registerFsConfigBackends, resolveDataGroup } from '@/lib/fs-config-backends'
import { attachDishGroup, detachDishGroup } from './store'

export const DISH_ORDER_APP_ID = 'dish-order'

interface Props {
  onReady?: () => void
}

export default function DishOrderSyncPanel({ onReady }: Props) {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState(true)
  const coreRef = useRef<{ getConnection?: () => any } | null>(null)

  useEffect(() => {
    registerFsConfigBackends()
    return () => detachDishGroup()
  }, [])

  const resolveFrom = useCallback(
    async (detail: any) => {
      const conn = detail ?? coreRef.current?.getConnection?.()
      const group = await resolveDataGroup(conn, DISH_ORDER_APP_ID)
      if (!group) {
        attachDishGroup(null)
        setReady(false)
        setMessage('已连接配置仓，请创建/选择含远端后端的 dish-order 数据同步组后重试')
        return
      }
      attachDishGroup(group)
      setReady(true)
      setMessage('数据同步组已连接')
      onReady?.()
    },
    [onReady],
  )

  const onConnected = useCallback(
    (data: any) => {
      resolveFrom(data).catch((e) => {
        attachDishGroup(null)
        setReady(false)
        setMessage(`连接失败：${String(e)}`)
      })
    },
    [resolveFrom],
  )

  const onBackendAdded = useCallback(() => void resolveFrom(undefined), [resolveFrom])
  const onDataGroupCreated = useCallback((data: any) => void resolveFrom(data), [resolveFrom])
  const onError = useCallback((data: any) => setMessage(`配置错误：${data?.message ?? ''}`), [])

  return (
    <details
      className="rounded-lg bg-white/5 p-3 text-sm"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer font-medium">
        数据同步组（appId: {DISH_ORDER_APP_ID}）{ready ? '· 已连接' : '· 未连接'}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs opacity-70">
          点菜记录按月分片存于此同步组的 /orders/YYYY/MM 下，后端地址 / token / 基准路径在下方配置。
        </p>
        <div className="max-h-96 overflow-auto rounded bg-white/5 p-2">
          <SyncGroupConfigurator
            appId={DISH_ORDER_APP_ID}
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
