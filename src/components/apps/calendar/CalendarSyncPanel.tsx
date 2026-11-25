/**
 * 日历「数据同步组」面板（zen-fs-config-ui V2）。
 *
 * 一个 appId 只能有一个连接：页面先用 connectV2('calendar') 建连接并把同一份 repo
 * 传给 SyncGroupConfiguratorV2，UI 不再自行连接。repo 提供 DataGroup.fs 给
 * universal-sync-v2，数据组自己的后端同步负责把文件推到远端。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { SyncGroupConfiguratorV2 } from 'zen-fs-config-ui/react'
import { connectV2, type AppRepo, type DataGroupInfo } from 'zen-fs-config'
import { registerFsConfigBackends } from '@/lib/fs-config-backends'
import {
  attachCalendarGroup,
  attachCalendarRepo,
  detachCalendarRepo,
  flushCalendarGroup,
  getCalendarSyncError,
  isCalendarGroupReady,
  syncCalendarNow,
} from '@/lib/calendar-sync'

const APP_ID = 'calendar'

interface Props {
  /** 同步完成后回调，页面据此重读 PouchDB */
  onReady?: () => void
}

export default function CalendarSyncPanel({ onReady }: Props) {
  const [repo, setRepo] = useState<AppRepo | null>(null)
  const [groups, setGroups] = useState<DataGroupInfo[]>([])
  const [activeGroup, setActiveGroup] = useState<string>('')
  const [message, setMessage] = useState('正在连接数据同步组…')
  const [busy, setBusy] = useState(false)
  const repoRef = useRef<AppRepo | null>(null)
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  const refreshGroups = useCallback(async (current: AppRepo) => {
    const list = await current.listDataGroups()
    setGroups(list)
  }, [])

  useEffect(() => {
    registerFsConfigBackends()
    let alive = true
    void connectV2(APP_ID)
      .then(async (connected) => {
        if (!alive) return
        repoRef.current = connected
        setRepo(connected)
        await attachCalendarRepo(connected)
        if (!alive) return
        await refreshGroups(connected)
        const infos = await connected.listDataGroups()
        setActiveGroup(infos[0]?.id ?? '')
        setMessage(getCalendarSyncError() ? `已连接，但同步失败：${getCalendarSyncError()}` : '已连接并同步')
        readyRef.current?.()
      })
      .catch((e) => setMessage(`连接失败：${String(e)}`))
    return () => {
      alive = false
      detachCalendarRepo()
    }
  }, [refreshGroups])

  const onRepoReady = useCallback(
    (sameRepo: any) => {
      // UI 复用页面创建的同一份 repo；若不是同一实例，忽略以免出现第二个连接。
      if (sameRepo !== repoRef.current) return
      void refreshGroups(sameRepo)
    },
    [refreshGroups],
  )

  const onGroupPick = useCallback(
    async (id: string) => {
      const current = repoRef.current
      if (!current || !id) return
      setBusy(true)
      try {
        const group = await current.getDataGroup(id)
        await attachCalendarGroup(group)
        setActiveGroup(id)
        setMessage(`已切换数据组 ${id.slice(0, 8)}…`)
        readyRef.current?.()
      } catch (e) {
        setMessage(`切换失败：${String(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const manualSync = useCallback(async () => {
    setBusy(true)
    const ok = await syncCalendarNow()
    const flushed = ok ? await flushCalendarGroup() : false
    setMessage(ok ? (flushed ? '同步并推送完成' : '已同步到本地数据组，远端推送失败') : `同步失败：${getCalendarSyncError()}`)
    if (ok) readyRef.current?.()
    setBusy(false)
  }, [])

  return (
    <details className="rounded-lg bg-white/5 border border-white/10 p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        数据同步组（appId: calendar）{isCalendarGroupReady() ? ' · 已连接' : ' · 未连接'}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-white/50">
          事件存独立库 onenav-calendar，经 universal-sync-v2 写入数据组文件系统，再由下方面板配置的后端跨设备同步。
        </p>
        {groups.length > 0 && (
          <label className="flex items-center gap-2 text-xs">
            数据组
            <select
              value={activeGroup}
              disabled={busy}
              onChange={(e) => void onGroupPick(e.target.value)}
              className="rounded bg-white/10 px-2 py-1 text-white/90 [color-scheme:dark]"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name || g.id.slice(0, 8)}
                  {g.hasRemote ? '' : '（仅本地）'}
                </option>
              ))}
            </select>
          </label>
        )}
        {repo ? (
          <div className="max-h-96 overflow-auto rounded bg-white/5 p-2">
            <SyncGroupConfiguratorV2
              appId={APP_ID}
              repo={repo}
              onRepoReady={onRepoReady}
              onSync={() => readyRef.current?.()}
              onError={(data: any) => setMessage(`配置错误：${data?.message ?? ''}`)}
            />
          </div>
        ) : (
          <p className="text-xs text-white/40">正在加载同步配置面板…</p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void manualSync()}
            disabled={!isCalendarGroupReady() || busy}
            className="rounded bg-emerald-600 px-3 py-1 disabled:opacity-40"
          >
            立即同步
          </button>
          {activeGroup && <span className="font-mono text-xs text-white/40">组 {activeGroup.slice(0, 8)}</span>}
        </div>
        {message && <p className="text-xs opacity-80">{message}</p>}
      </div>
    </details>
  )
}
