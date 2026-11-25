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
import { registerFsConfigBackends, ensureDataGroup } from '@/lib/fs-config-backends'
import { attachDishGroup, detachDishGroup } from './store'

export const DISH_ORDER_APP_ID = 'dish-order'

interface Props {
  onReady?: () => void
}

export default function DishOrderSyncPanel({ onReady }: Props) {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState(true)
  // 自动创建本机默认组后重挂配置面板，让它重新列出数据组
  const [uiNonce, setUiNonce] = useState(0)
  const coreRef = useRef<{ getConnection?: () => any } | null>(null)

  useEffect(() => {
    registerFsConfigBackends()
    return () => detachDishGroup()
  }, [])

  const resolveFrom = useCallback(
    async (detail: any) => {
      const conn = detail ?? coreRef.current?.getConnection?.()
      // 每个 appId 必须有一个可用数据组实例；没有描述符时补建本机默认组（仅隐式 local-idb）
      const { group, created, descriptorsUnavailable, candidates } = await ensureDataGroup(
        conn,
        DISH_ORDER_APP_ID,
        { preferPath: '/orders' },
      )
      if (!group) {
        attachDishGroup(null)
        setReady(false)
        setMessage(
          descriptorsUnavailable
            ? '有 dish-order 数据组描述符但本机加载失败（后端不可用？），暂不创建默认组以免覆盖远端组'
            : `有 ${candidates.length} 个候选组但无法判定，请在数据同步组面板里点选正确的组`,
        )
        return
      }
      attachDishGroup(group)
      setReady(true)
      if (created) setUiNonce((n) => n + 1)
      setMessage(
        created
          ? '已创建本机默认数据组 default（仅本地 IndexedDB，不参与远端同步）· 点菜记录已保存到该组；添加远端后端即可跨设备同步'
          : '数据同步组已连接',
      )
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
            key={uiNonce}
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
