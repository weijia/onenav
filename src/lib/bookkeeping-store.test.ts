// 记账数据「保存 → 同步到后端」行为验证测试。
//
// 背景 / 待验证缺陷（bookkeeping-data-model.md 声称）：
//   - RemoteStorage 整库同步自动覆盖 bk: 文档；
//   - WebDAV 兜底聚合为 app_data/onenav/apps/bookkeeping-records.json。
//
// 根因假设：记账是独立 HTML 页（apps/bookkeeping/index.html，独立 Vite 入口 / 独立模块实例），
//   该页从不调用 configureRemoteStorage()/syncToRemoteStorage()，因此
//   remotestorage-sync.ts 的模块级 isConfigured 恒为 false，afterWrite() 的
//   `if (isRemoteStorageConfigured())` 分支永远跳过 → 记账数据只落本地 PouchDB，不 push 到 RemoteStorage。
//
// 本测试通过 mock 掉 4 个依赖，在「未配置 RS（独立页状态）」与「已配置 RS（主应用状态）」两种
// 条件下驱动真实的 bookkeeping-store 代码路径，断言同步行为差异，从而验证上述根因。
// 注意：不修改任何业务源码，只新增本测试。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 共享的可变状态（hoisted，供 mock 工厂闭包引用）──
const h = vi.hoisted(() => ({
  // RemoteStorage 是否「已配置」（对应独立记账页 false / 主应用 true）
  configured: false,
  // scheduleAutoSync 被调用的次数
  scheduleSyncCalls: 0,
  // WebDAV 配置（null 表示未配置）
  wdav: null as null | { url: string; username: string; password: string },
  // WebDAV 侧实际写入的 {path, content} 列表
  webdavWrites: [] as Array<{ path: string; content: string }>,
  // WebDAV 文件读取兜底（loadAllRecords 空库回退用；null 表示文件不存在 → 抛错）
  wdavFile: null as string | null,
  // 假 PouchDB（由 makeFakeDb 构造后挂到这里）
  db: null as any,
}))

vi.mock('@/lib/remotestorage-sync', () => ({
  isRemoteStorageConfigured: () => h.configured,
  scheduleAutoSync: vi.fn(async () => {
    h.scheduleSyncCalls++
  }),
}))

vi.mock('@/lib/config', () => ({
  loadWebDAVConfig: () => h.wdav,
}))

vi.mock('@/lib/webdav', () => ({
  createDirectory: vi.fn(async () => {}),
  putFileContents: vi.fn(async (_cfg: unknown, path: string, content: string) => {
    h.webdavWrites.push({ path, content })
  }),
  getFileContents: vi.fn(async (_cfg: unknown, _path: string) => {
    if (h.wdavFile == null) throw new Error('ENOENT')
    return h.wdavFile
  }),
}))

vi.mock('@/lib/pouchdb', () => ({
  getPouchDB: async () => h.db,
}))

// 导入被测模块（在 vi.mock 之后）
import {
  putRecords,
  removeRecord,
  loadAllRecords,
  type TxRecord,
  type PriceRecord,
} from './bookkeeping-store'

// ── 假 PouchDB：仅实现本测试用到的最小 API ──
function makeFakeDb() {
  const docs = new Map<string, any>()
  const db = {
    async bulkDocs(list: any[]) {
      for (const d of list) docs.set(d._id, { ...d })
      return list.map(() => ({ ok: true }))
    },
    async allDocs(_opts: any) {
      const rows: any[] = []
      for (const d of docs.values()) rows.push({ id: d._id, doc: d })
      return { rows }
    },
    async get(id: string) {
      const d = docs.get(id)
      if (!d) throw Object.assign(new Error('missing'), { status: 404 })
      return d
    },
    async remove(doc: any) {
      docs.delete(doc._id)
    },
  }
  return { db, docs }
}

// 构造一条普通流水记录
function makeTx(): TxRecord {
  return {
    id: 'tx-1',
    type: 'tx',
    direction: 'expense',
    amount: 35,
    category: '餐饮',
    note: '午餐',
    date: '2026-10-24',
    createdAt: 1,
  }
}

// 构造一条价格记录
function makePrice(): PriceRecord {
  return {
    type: 'price',
    kind: 'item',
    id: 'p-1',
    product: '鸡蛋',
    unit: '斤',
    unitPrice: 5.8,
    date: '2026-10-24',
    createdAt: 1,
  }
}

beforeEach(() => {
  h.configured = false
  h.scheduleSyncCalls = 0
  h.wdav = null
  h.webdavWrites = []
  h.wdavFile = null
  const built = makeFakeDb()
  h.db = built.db
})

describe('记账 putRecords 写后同步（afterWrite）', () => {
  it('A-1 独立记账页（未配置 RemoteStorage）：只写本地 PouchDB，不触发 RS 同步', async () => {
    // 独立页状态：isRemoteStorageConfigured() === false（该页从未建立连接）
    h.configured = false
    h.wdav = null

    await putRecords([makeTx()])

    // 本地确实落库（bk:tx:tx-1 存在）
    const stored = await h.db.get('bk:tx:tx-1')
    expect(stored.amount).toBe(35)
    expect(stored.type).toBe('tx')
    // 但从未触发 RemoteStorage 同步 —— 根因所在
    expect(h.scheduleSyncCalls).toBe(0)
    // 也未配置 WebDAV 兜底
    expect(h.webdavWrites).toHaveLength(0)
  })

  it('A-2 主应用（已配置 RemoteStorage）：写入后触发 scheduleAutoSync 推送后端', async () => {
    h.configured = true
    h.wdav = null

    await putRecords([makeTx()])

    expect(await h.db.get('bk:tx:tx-1')).toBeDefined()
    expect(h.scheduleSyncCalls).toBeGreaterThanOrEqual(1)
  })

  it('A-3 已配置 WebDAV：写入后把整库记账聚合为 bookkeeping-records.json', async () => {
    h.configured = false // 即使 RS 未配置，WebDAV 兜底也应生效
    h.wdav = { url: 'https://wdav.test', username: 'u', password: 'p' }

    await putRecords([makeTx(), makePrice()])

    expect(h.webdavWrites).toHaveLength(1)
    const w = h.webdavWrites[0]
    expect(w.path).toBe('app_data/onenav/apps/bookkeeping-records.json')
    const parsed = JSON.parse(w.content)
    expect(parsed.records).toHaveLength(2)
    expect(parsed.records.map((r: any) => r.id)).toContain('tx-1')
    expect(parsed.records.map((r: any) => r.id)).toContain('p-1')
  })

  it('A-4 删除记录 removeRecord 同样走 afterWrite：未配置 RS 时不触发同步', async () => {
    h.configured = false
    h.wdav = null
    await putRecords([makeTx()])
    expect(h.scheduleSyncCalls).toBe(0)

    await removeRecord(makeTx())
    await expect(h.db.get('bk:tx:tx-1')).rejects.toMatchObject({ status: 404 })
    // 删除也未触发任何后端同步
    expect(h.scheduleSyncCalls).toBe(0)
    expect(h.webdavWrites).toHaveLength(0)
  })
})

describe('记账 loadAllRecords 读取路径', () => {
  it('B-1 从本地 PouchDB 读取 bk: 文档（独立页数据可见）', async () => {
    await putRecords([makeTx(), makePrice()])
    h.scheduleSyncCalls = 0 // 清掉写入时的计数，只看读取

    const all = await loadAllRecords()
    expect(all.map((r) => r.id).sort()).toEqual(['p-1', 'tx-1'])
  })

  it('B-2 本地空库时回退读取 WebDAV 聚合文件并回灌 PouchDB', async () => {
    // 空本地库
    h.configured = false
    h.wdav = { url: 'https://wdav.test', username: 'u', password: 'p' }
    h.wdavFile = JSON.stringify({
      updatedAt: 1,
      records: [{ id: 'legacy-1', type: 'tx', direction: 'income', amount: 100, category: '工资', date: '2026-10-01', createdAt: 1 }],
    })

    const all = await loadAllRecords()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('legacy-1')
    // 已回灌到本地 PouchDB
    expect(await h.db.get('bk:tx:legacy-1')).toBeDefined()
  })

  it('B-3 空库且无 WebDAV：返回空数组（不抛错）', async () => {
    h.configured = false
    h.wdav = null
    const all = await loadAllRecords()
    expect(all).toEqual([])
  })

  it('B-4 价格记录带 note：写入 PouchDB 后再读取，note 完整保留', async () => {
    h.configured = false
    h.wdav = null
    const withNote: PriceRecord = {
      type: 'price',
      kind: 'item',
      id: 'p-note',
      product: '维生素AD',
      unit: '粒',
      unitPrice: 0.82,
      note: '药店买的，活动价',
      date: '2026-08-20',
      createdAt: 2,
    }
    await putRecords([withNote])
    // 落库的 PouchDB 文档带 note
    const stored = await h.db.get('bk:price:p-note')
    expect(stored.note).toBe('药店买的，活动价')
    // 读回后 note 仍然在
    const all = await loadAllRecords()
    const back = all.find((r) => r.id === 'p-note' && r.type === 'price') as PriceRecord | undefined
    expect(back).toBeDefined()
    if (back) {
      expect(back.kind).toBe('item')
      if (back.kind === 'item') {
        expect(back.note).toBe('药店买的，活动价')
        expect(back.unitPrice).toBe(0.82)
      }
    }
  })
})
