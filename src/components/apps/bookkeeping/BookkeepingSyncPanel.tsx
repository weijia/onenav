/**
 * 记账「数据同步组」面板。
 *
 * 用 zen-fs-config-ui 的 SyncGroupConfigurator 配置 appId=bookkeeping 的数据同步后端；
 * 连上数据组后把 live 引用交给 bookkeeping-sync，驱动独立库的同步链路。
 * 记账数据只经数据组跨设备同步，不再随主库（书签/配置）同步。
 *
 * 一个 appId 下可能有多份数据组（历史 default 空组等），这里列出候选让用户显式选定，
 * 并显示实际挂载的组 id，避免同步写进空组。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { SyncGroupConfigurator } from 'zen-fs-config-ui/react'
import {
  collectDataGroupCandidates,
  ensureDataGroup,
  registerFsConfigBackends,
  setPreferredDataGroupId,
  type DataGroupCandidate,
} from '@/lib/fs-config-backends'
import {
  attachBookkeepingDataGroup,
  detachBookkeepingDataGroup,
  getBookkeepingSyncError,
  syncBookkeepingNow,
} from '@/lib/bookkeeping-sync'
import { DataGroupChoiceList } from 'zen-fs-config-ui/react'

const APP_ID = 'bookkeeping'
const DATA_PATH = '/bookkeeping'

interface Props {
  /** 数据组连上并完成首轮同步后回调（页面据此重读独立库） */
  onReady?: () => void
}

export default function BookkeepingSyncPanel({ onReady }: Props) {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [choices, setChoices] = useState<DataGroupCandidate[]>([])
  const [busy, setBusy] = useState(false)
  // 自动创建本机默认组后重挂配置面板，让它重新列出数据组（否则卡片仍显示「暂无数据同步组」）
  const [uiNonce, setUiNonce] = useState(0)
  const coreRef = useRef<{ getConnection?: () => any } | null>(null)

  useEffect(() => {
    registerFsConfigBackends()
    return () => detachBookkeepingDataGroup()
  }, [])

  const attach = useCallback(
    async (group: any) => {
      if (!group) {
        setReady(false)
        setMessage('没有可用的 bookkeeping 数据组')
        return
      }
      setBusy(true)
      const id = String(group.groupId ?? '')
      try {
        await attachBookkeepingDataGroup(group)
        setActiveId(id)
        setReady(true)
        const err = getBookkeepingSyncError()
        setMessage(err ? `已挂载 ${id.slice(0, 8)}…，同步失败：${err}` : `已挂载 ${id.slice(0, 8)}… · 已同步`)
        onReady?.()
      } catch (e) {
        setReady(false)
        setMessage(`挂载失败：${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [onReady],
  )

  const refresh = useCallback(
    async (detail?: any) => {
      const conn = detail ?? coreRef.current?.getConnection?.()
      // 每个 appId 必须有至少一个数据组实例；没有描述符时补建本机默认组（仅隐式 local-idb）
      const { group: picked, candidates: cands, created, descriptorsUnavailable } = await ensureDataGroup(
        conn,
        APP_ID,
        { preferPath: DATA_PATH },
      )
      setChoices(cands)
      if (!picked) {
        detachBookkeepingDataGroup()
        setReady(false)
        setActiveId(null)
        setMessage(
          descriptorsUnavailable
            ? '有 bookkeeping 数据组描述符但本机加载失败（后端不可用？），暂不创建默认组以免覆盖远端组'
            : `有 ${cands.length} 个候选组但无法判定，请在上面点选正确的组`,
        )
        return
      }
      await attach(picked)
      if (created) {
        setUiNonce((n) => n + 1)
        setMessage(
          '已创建本机默认数据组 default（仅本地 IndexedDB，不参与远端同步）· 记账数据已保存到该组；' +
            '在下方给它添加 RemoteStorage/Gitee 后端即可跨设备同步',
        )
      }
    },
    [attach],
  )

  const onConnected = useCallback(
    (data: any) => {
      refresh(data).catch((e) => {
        setReady(false)
        setMessage(`连接失败：${String(e)}`)
      })
    },
    [refresh],
  )

  const onBackendAdded = useCallback(() => void refresh(undefined), [refresh])
  const onDataGroupCreated = useCallback(
    async (data: any) => {
      // 新建组直接挂载 live 实例，保证「建了就被程序用」，而不是仍挂在旧组上
      if (data?.groupId) setPreferredDataGroupId(APP_ID, String(data.groupId))
      if (data?.dataGroup?.fs?.promises) {
        await attach(data.dataGroup)
        const conn = coreRef.current?.getConnection?.()
        setChoices(await collectDataGroupCandidates(conn, APP_ID, DATA_PATH))
        return
      }
      await refresh(undefined)
    },
    [attach, refresh],
  )
  const onError = useCallback((data: any) => setMessage(`配置错误：${data?.message ?? ''}`), [])

  const onPick = useCallback(
    (id: string) => {
      const cand = choices.find((c) => c.id === id)
      if (!cand) return
      setPreferredDataGroupId(APP_ID, id)
      void attach(cand.group)
    },
    [choices, attach],
  )

  const manualSync = useCallback(async () => {
    const ok = await syncBookkeepingNow()
    setMessage(ok ? '同步完成' : `同步失败：${getBookkeepingSyncError() ?? '数据组未连接'}`)
    if (ok) onReady?.()
  }, [onReady])

  return (
    <details className="rounded-lg bg-white/5 border border-white/10 p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        数据同步组（appId: bookkeeping）{ready ? `· 已连接 ${activeId ? activeId.slice(0, 8) : ''}` : '· 未连接'}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-white/50">
          记账数据存独立库（onenav-bookkeeping），经此数据同步组备份到远端；不再写入主库（书签/配置的同步链路）。
        </p>
        <DataGroupChoiceList
          appId={APP_ID}
          candidates={choices}
          activeId={activeId}
          onPick={onPick}
          busy={busy}
          dataPath={DATA_PATH}
        />
        <div className="max-h-96 overflow-auto rounded bg-white/5 p-2">
          <SyncGroupConfigurator
            key={uiNonce}
            appId={APP_ID}
            onCoreReady={(core) => {
              coreRef.current = core
            }}
            onConnected={onConnected}
            onBackendAdded={onBackendAdded}
            onDataGroupCreated={onDataGroupCreated}
            onError={onError}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={manualSync}
            disabled={!ready || busy}
            className="rounded bg-emerald-600 px-3 py-1 disabled:opacity-40"
          >
            立即同步
          </button>
          {activeId && <span className="font-mono text-xs text-white/40">组 {activeId}</span>}
        </div>
        {message && <p className="text-xs opacity-80">{message}</p>}
      </div>
    </details>
  )
}
