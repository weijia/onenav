/**
 * 两个高尔夫页面共用的「数据同步组」面板。
 *
 * 用 zen-fs-config-ui 的 SyncGroupConfigurator 让用户配置 appId=golf 的同步后端；
 * 连上数据组后把 live 引用交给 golf-sync，驱动 golf 独立库的同步链路。
 *
 * 关键：一个 appId 下可能有多份数据组（历史 `default` 空组、换过后端的旧组），
 * `connect()` 只会取第一个。这里把候选全列出来，选中后记在本机偏好里，
 * 并在面板上显示「当前挂载」的组 id，避免默默同步到空组。
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
import { attachGolfDataGroup, detachGolfDataGroup, syncGolfNow, getGolfSyncError } from '@/lib/golf-sync'
import { DataGroupChoiceList } from 'zen-fs-config-ui/react'

const APP_ID = 'golf'
const DATA_PATH = '/golf'

interface Props {
  /** 外壳主题：地图页深色传 dark，导航页白底传 light */
  theme?: 'dark' | 'light'
}

export default function GolfSyncPanel({ theme = 'dark' }: Props) {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [choices, setChoices] = useState<DataGroupCandidate[]>([])
  const [busy, setBusy] = useState(false)
  // 自动创建本机默认组后重挂 SyncGroupConfigurator，让它重新 listAppDataGroups，
  // 否则下方「同步组」卡片会一直显示「暂无数据同步组」直到刷新页面。
  const [uiNonce, setUiNonce] = useState(0)
  const coreRef = useRef<{ getConnection?: () => any } | null>(null)

  useEffect(() => {
    registerFsConfigBackends()
    return () => detachGolfDataGroup()
  }, [])

  const attach = useCallback(async (group: any) => {
    if (!group) {
      setReady(false)
      setMessage('没有可用的 golf 数据组')
      return
    }
    setBusy(true)
    const id = String(group.groupId ?? '')
    try {
      await attachGolfDataGroup(group)
      setActiveId(id)
      setReady(true)
      const err = getGolfSyncError()
      setMessage(err ? `已挂载 ${id.slice(0, 8)}…，同步失败：${err}` : `已挂载 ${id.slice(0, 8)}… · 已同步`)
    } catch (e) {
      setReady(false)
      setMessage(`挂载失败：${String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const refresh = useCallback(
    async (detail?: any) => {
      const conn = detail ?? coreRef.current?.getConnection?.()
      // 必须有一个数据组实例：一个描述符都没有时补建本机默认组（只有隐式 local-idb），
      // 这样 golf 的数据始终有一个组可读写；有描述符但加载失败时不会乱建。
      const { group: picked, candidates: cands, created, descriptorsUnavailable } = await ensureDataGroup(
        conn,
        APP_ID,
        { preferPath: DATA_PATH },
      )
      setChoices(cands)
      if (!picked) {
        detachGolfDataGroup()
        setReady(false)
        setActiveId(null)
        setMessage(
          descriptorsUnavailable
            ? '有 golf 数据组描述符但本机加载失败（后端不可用？），暂不创建默认组以免覆盖远端组'
            : `有 ${cands.length} 个候选组但无法判定，请在上面点选正确的组`,
        )
        return
      }
      await attach(picked)
      if (created) {
        setUiNonce((n) => n + 1)
        setMessage(
          '已创建本机默认数据组 default（仅本地 IndexedDB，不参与远端同步）· 数据已保存到该组；' +
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
      // 新建组通常就是用户想要的：记为本机偏好，并**直接用这个 live 实例挂载**，
      // 避免「凭空多出一个组、但程序仍在用旧组」——创建后必被本页读写。
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
    const ok = await syncGolfNow()
    setMessage(ok ? '同步完成' : `同步失败：${getGolfSyncError() ?? '数据组未连接'}`)
  }, [])

  const dark = theme === 'dark'
  return (
    <details
      className={`rounded-lg border p-3 text-sm ${
        dark ? 'bg-white/5 border-white/10' : 'bg-white border-slate-200'
      }`}
      open
    >
      <summary className={`cursor-pointer font-medium ${dark ? 'text-white/90' : 'text-slate-800'}`}>
        数据同步组（appId: golf）{ready ? `· 已连接 ${activeId ? activeId.slice(0, 8) : ''}` : '· 未连接'}
      </summary>
      <div className="mt-3 space-y-2">
        <p className={`text-xs ${dark ? 'text-white/50' : 'text-slate-500'}`}>
          球场数据存独立库，经此同步组备份到远端；两个高尔夫页面共享同一份数据。
          一个 appId 下可能有多份数据组，请确认「当前」那份是真在用的。
        </p>
        <DataGroupChoiceList
          appId={APP_ID}
          candidates={choices}
          activeId={activeId}
          onPick={onPick}
          busy={busy}
          dataPath={DATA_PATH}
          variant={dark ? 'dark' : 'light'}
        />
          <div className={`max-h-96 overflow-auto rounded p-2 ${dark ? 'bg-white/5' : 'bg-slate-50'}`}>
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
          {activeId && (
            <span className={`font-mono text-xs ${dark ? 'text-white/40' : 'text-slate-500'}`}>
              组 {activeId}
            </span>
          )}
        </div>
        {message && <p className={`text-xs ${dark ? 'text-white/60' : 'text-slate-600'}`}>{message}</p>}
      </div>
    </details>
  )
}
