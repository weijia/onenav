// 数据组解析回归测试：核心是「一个 appId 下有多个数据组时不能盲取第一个」。
//
// 背景：golf 页此前只取 repo.listAppDataGroups() 的第一个组（connect() 也是
// `appDataGroups[0]`），存在历史 `default` 空组时会把数据写进空组，表现为
// 「没有同步到正确的数据组」。这里用假 repo 复现该场景并锁定选择顺序。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  collectDataGroupCandidates,
  ensureDataGroup,
  getPreferredDataGroupId,
  resolveDataGroup,
  setPreferredDataGroupId,
} from './fs-config-backends'

// Node 测试环境没有 localStorage，这里补一个最小的实现
class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
}

/** 假数据组：只有 fs.promises.readdir 与后端列表，足够解析逻辑使用 */
function makeGroup(id: string, opts: { data?: boolean; remote?: boolean; name?: string } = {}) {
  const backends = opts.remote === false
    ? [{ id: 'local', type: 'IndexedDB' }]
    : [{ id: 'rs', type: 'RemoteStorage' }]
  return {
    groupId: id,
    name: opts.name,
    fs: {
      promises: {
        readdir: async (path: string) => (opts.data && path === '/golf' ? ['course.json'] : []),
      },
    },
    listBackends: () => backends,
    listDeclaredBackends: () => backends,
  }
}

/** 假配置仓：descriptors 顺序即「第几个」，用于复现「取第一个」的旧 bug */
function makeRepo(groups: any[]) {
  return {
    listAppDataGroups: async () =>
      groups.map((g) => ({ id: g.groupId, name: g.name, groupType: 'data-sync', backends: g.listBackends() })),
    getAppDataGroup: async (id: string) => {
      const g = groups.find((x) => x.groupId === id)
      if (!g) throw new Error(`App data group "${id}" not found`)
      return g
    },
  }
}

const UIUD = 'c5b50d9d-0174-4599-ba20-239d32375de2'

beforeEach(() => {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('多数据组时的选择顺序（golf 场景）', () => {
  it('R-1 列表第一个是空的 default 组，也应选中 /golf 下真有数据的组', async () => {
    const emptyDefault = makeGroup('default', { data: false, remote: false })
    const real = makeGroup(UIUD, { data: true, remote: true, name: 'golf-rs' })
    const repo = makeRepo([emptyDefault, real])

    const picked = await resolveDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })
    expect((picked as any).groupId).toBe(UIUD)
  })

  it('R-2 本机记住的选择优先（即使它暂时没有 /golf 内容）', async () => {
    const real = makeGroup(UIUD, { data: true, remote: true })
    const other = makeGroup('default', { data: false, remote: true })
    const repo = makeRepo([real, other])

    setPreferredDataGroupId('golf', 'default')
    expect(getPreferredDataGroupId('golf')).toBe('default')

    const picked = await resolveDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })
    expect((picked as any).groupId).toBe('default')
  })

  it('R-3 记住的组在本机配置仓里不存在时，回退到有内容的组（并告警）', async () => {
    setPreferredDataGroupId('golf', 'gone-on-this-device')
    const real = makeGroup(UIUD, { data: true, remote: true })
    const repo = makeRepo([makeGroup('default', { data: false }), real])

    const picked = await resolveDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })
    expect((picked as any).groupId).toBe(UIUD)
    expect(console.warn).toHaveBeenCalled()
  })

  it('R-4 只有一个候选组时直接用它（不要求有数据）', async () => {
    const only = makeGroup(UIUD, { data: false, remote: true })
    const picked = await resolveDataGroup({ repo: makeRepo([only]) } as any, 'golf', { preferPath: '/golf' })
    expect((picked as any).groupId).toBe(UIUD)
  })

  it('R-5 候选列表把「有数据 / 有远端」标出来，排序把有数据的置顶', async () => {
    const repo = makeRepo([
      makeGroup('default', { data: false, remote: false }),
      makeGroup(UIUD, { data: true, remote: true, name: 'golf-rs' }),
    ])
    const cands = await collectDataGroupCandidates({ repo } as any, 'golf', '/golf')
    expect(cands.map((c) => c.id)).toEqual([UIUD, 'default'])
    expect(cands[0]).toMatchObject({ hasData: true, hasRemote: true, backendTypes: ['RemoteStorage'] })
    expect(cands[1]).toMatchObject({ hasData: false, hasRemote: false, backendTypes: ['IndexedDB'] })
    // 每个组都带隐式本地主存储（浏览器里是 IndexedDB），页面据此显示 local-idb 行
    expect(cands[0].localStore).toBe(`zen-fs-config-data-golf-${UIUD}`)
    expect(cands[1].localStore).toBe('zen-fs-config-data-golf')
  })
})

describe('ensureDataGroup：appId 必须至少有一个数据组实例', () => {
  function makeCreatingRepo(initial: any[] = [], opts: { failLoad?: boolean } = {}) {
    const groups = [...initial]
    const create = vi.fn(async (id: string, _backends: any[]) => {
      const g = makeGroup(id, { remote: false })
      groups.push(g)
      return g
    })
    return {
      repo: {
        listAppDataGroups: async () =>
          groups.map((g) => ({ id: g.groupId, name: g.name, groupType: 'data-sync', backends: [] })),
        getAppDataGroup: async (id: string) => {
          if (opts.failLoad) throw new Error('backend unavailable')
          const g = groups.find((x) => x.groupId === id)
          if (!g) throw new Error(`App data group "${id}" not found`)
          return g
        },
        createAppDataGroup: create,
      },
      create,
    }
  }

  it('E-1 没有任何描述符 → 自动创建本机默认组并联通实例（仅隐式 local-idb）', async () => {
    const { repo, create } = makeCreatingRepo()
    const r = await ensureDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })
    expect(create).toHaveBeenCalledWith('default', [])
    expect(r.created).toBe(true)
    expect((r.group as any)?.groupId).toBe('default')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]).toMatchObject({ id: 'default', hasRemote: false, localStore: 'zen-fs-config-data-golf' })
  })

  it('E-2 已有唯一组 → 直接复用，不会新建 default', async () => {
    const { repo, create } = makeCreatingRepo([makeGroup('only-group', { data: true, remote: true })])
    const r = await ensureDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })
    expect(create).not.toHaveBeenCalled()
    expect(r.created).toBe(false)
    expect((r.group as any)?.groupId).toBe('only-group')
  })

  it('E-3 有描述符但加载失败 → 不建 default，避免覆盖远端组', async () => {
    const { repo, create } = makeCreatingRepo([makeGroup('remote-group', { remote: true })], { failLoad: true })
    const r = await ensureDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })
    expect(create).not.toHaveBeenCalled()
    expect(r.group).toBeNull()
    expect(r.descriptorsUnavailable).toBe(true)
  })
})

describe('无 repo / 空仓时的行为', () => {
  it('R-6 有 repo 但没有任何描述符：返回空且不自动建 default（避免污染候选）', async () => {
    const repo = { listAppDataGroups: async () => [] as any[], getAppDataGroup: async () => { throw new Error('none') } }
    expect(await resolveDataGroup({ repo } as any, 'golf', { preferPath: '/golf' })).toBeNull()
  })

  it('R-7 无 repo 时保留 dataGroup 直通（data-sync 模式）', async () => {
    const direct = makeGroup(UIUD, { data: true })
    expect((await resolveDataGroup({ dataGroup: direct } as any, 'golf', { preferPath: '/golf' }) as any).groupId).toBe(UIUD)
  })
})
