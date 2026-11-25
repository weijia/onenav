// 记账数据「保存 → 同步」行为验证测试。
//
// 架构（2026-11 起）：记账数据存独立库 `onenav-bookkeeping`，经 zen-fs-config
// 「数据同步组」（appId=bookkeeping）跨设备同步；不再写入主库 onenav（书签/配置的
// 同步链路），也不再聚合写 WebDAV。
//
// 本测试 mock 掉存储边界，驱动真实 bookkeeping-store 代码，断言：
//  - 读写都发生在独立库；
//  - 每次写入后调用 scheduleBookkeepingSync（由数据组同步层 debounce 同步）；
//  - 不再写 WebDAV 聚合文件（仍保留空库时的一次性 WebDAV 读取兜底）；
//  - 加载前会调用 migrateBookkeepingDocsFromMain（主库历史数据增量迁移）。

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 共享的可变状态（hoisted，供 mock 工厂闭包引用）──
const h = vi.hoisted(() => ({
  // scheduleBookkeepingSync 被调用的次数
  scheduleCalls: 0,
  // migrateBookkeepingDocsFromMain 被调用的次数
  migrateCalls: 0,
  // WebDAV 配置（null 表示未配置）
  wdav: null as null | { url: string; username: string; password: string },
  // WebDAV 侧实际写入的 {path, content} 列表（改造后应始终为空）
  webdavWrites: [] as Array<{ path: string; content: string }>,
  // WebDAV 文件读取兜底（loadAllRecords 空库回退用；null 表示文件不存在 → 抛错）
  wdavFile: null as string | null,
  // 假 PouchDB（由 makeFakeDb 构造后挂到这里）
  db: null as any,
}))

vi.mock('@/lib/bookkeeping-db', () => ({
  BK_PREFIX: 'bk:',
  BK_END: 'bk:\uffff',
  getBookkeepingDb: async () => h.db,
  getBookkeepingPouchDB: async () => h.db,
  migrateBookkeepingDocsFromMain: async () => {
    h.migrateCalls++
    return 0
  },
}))

vi.mock('@/lib/bookkeeping-sync', () => ({
  BOOKKEEPING_SYNCED_EVENT: 'bookkeeping:synced',
  scheduleBookkeepingSync: vi.fn(() => {
    h.scheduleCalls++
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

// 导入被测模块（在 vi.mock 之后）
import {
  putRecords,
  removeRecord,
  loadAllRecords,
  updateRecord,
  type TxRecord,
  type PriceRecord,
} from './bookkeeping-store'

// ── 假 PouchDB：仅实现本测试用到的最小 API ──
function makeFakeDb() {
  const docs = new Map<string, any>()
  const db = {
    async put(doc: any) {
      docs.set(doc._id, { ...doc })
      return { ok: true, id: doc._id, rev: '1' }
    },
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
  h.scheduleCalls = 0
  h.migrateCalls = 0
  h.wdav = null
  h.webdavWrites = []
  h.wdavFile = null
  const built = makeFakeDb()
  h.db = built.db
})

describe('记账写入：落独立库 + 触发数据组同步', () => {
  it('A-1 写入记录：落到独立库，并调用 scheduleBookkeepingSync', async () => {
    await putRecords([makeTx()])

    const stored = await h.db.get('bk:tx:tx-1')
    expect(stored.amount).toBe(35)
    expect(stored.type).toBe('tx')
    expect(h.scheduleCalls).toBe(1)
    // 不再聚合写 WebDAV
    expect(h.webdavWrites).toHaveLength(0)
  })

  it('A-2 已配置 WebDAV 也不再把记账数据写进 WebDAV（数据只走数据同步组）', async () => {
    h.wdav = { url: 'https://wdav.test', username: 'u', password: 'p' }

    await putRecords([makeTx(), makePrice()])

    expect(h.scheduleCalls).toBe(1)
    expect(h.webdavWrites).toHaveLength(0)
  })

  it('A-3 删除记录同样触发数据组同步', async () => {
    await putRecords([makeTx()])
    h.scheduleCalls = 0

    await removeRecord(makeTx())
    await expect(h.db.get('bk:tx:tx-1')).rejects.toMatchObject({ status: 404 })
    expect(h.scheduleCalls).toBe(1)
    expect(h.webdavWrites).toHaveLength(0)
  })
})

describe('记账 loadAllRecords 读取路径', () => {
  it('B-1 加载前先做「主库历史文档」增量迁移，再从独立库读取', async () => {
    await putRecords([makeTx(), makePrice()])
    h.scheduleCalls = 0

    const all = await loadAllRecords()
    expect(h.migrateCalls).toBe(1)
    expect(all.map((r) => r.id).sort()).toEqual(['p-1', 'tx-1'])
  })

  it('B-2 独立库为空时仍可一次性读取 WebDAV 旧聚合文件并回灌', async () => {
    h.wdav = { url: 'https://wdav.test', username: 'u', password: 'p' }
    h.wdavFile = JSON.stringify({
      updatedAt: 1,
      records: [{ id: 'legacy-1', type: 'tx', direction: 'income', amount: 100, category: '工资', date: '2026-10-01', createdAt: 1 }],
    })

    const all = await loadAllRecords()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('legacy-1')
    // 已回灌到独立库
    expect(await h.db.get('bk:tx:legacy-1')).toBeDefined()
    // 读取路径本身不触发写后同步
    expect(h.scheduleCalls).toBe(0)
  })

  it('B-3 空库且无 WebDAV：返回空数组（不抛错）', async () => {
    const all = await loadAllRecords()
    expect(all).toEqual([])
  })

  it('B-4 价格记录带 note：写入独立库后再读取，note 完整保留', async () => {
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
    const stored = await h.db.get('bk:price:p-note')
    expect(stored.note).toBe('药店买的，活动价')

    const all = await loadAllRecords()
    const back = all.find((r) => r.id === 'p-note' && r.type === 'price') as PriceRecord | undefined
    expect(back).toBeDefined()
    if (back && back.kind === 'item') {
      expect(back.note).toBe('药店买的，活动价')
      expect(back.unitPrice).toBe(0.82)
    }
  })
})

describe('记账 updateRecord 更新已有记录', () => {
  it('U-1 更新价格记录的单价与备注，独立库文档被覆盖且保留身份字段', async () => {
    const p = makePrice() as Extract<PriceRecord, { kind: 'item' }>
    await putRecords([p])

    const updated: PriceRecord = { ...p, unitPrice: 6.5, note: '涨价了', quantity: 2 }
    await updateRecord(updated)

    const stored = await h.db.get('bk:price:p-1')
    expect(stored.unitPrice).toBe(6.5)
    expect(stored.note).toBe('涨价了')
    expect(stored.quantity).toBe(2)
    expect(stored.id).toBe('p-1')
    expect(stored.type).toBe('price')
    expect(stored.createdAt).toBe(1)

    const all = await loadAllRecords()
    expect(all).toHaveLength(1)
    const back = all[0] as PriceRecord
    if (back.kind === 'item') expect(back.unitPrice).toBe(6.5)
  })

  it('U-2 更新不存在的记录时按新增兜底（不抛错）', async () => {
    const missing: PriceRecord = {
      type: 'price',
      kind: 'item',
      id: 'p-x',
      product: '缺文件',
      unit: '份',
      unitPrice: 9,
      date: '2026-10-25',
      createdAt: 3,
    }
    await expect(updateRecord(missing)).resolves.toBeUndefined()
    const stored = await h.db.get('bk:price:p-x')
    expect(stored.unitPrice).toBe(9)
  })

  it('U-3 更新后触发数据组同步（不写 WebDAV）', async () => {
    h.wdav = { url: 'https://wdav.test', username: 'u', password: 'p' }
    const tx = makeTx()
    await putRecords([tx])
    h.scheduleCalls = 0

    await updateRecord({ ...tx, amount: 88, note: '改后' })

    expect(await h.db.get('bk:tx:tx-1')).toMatchObject({ amount: 88 })
    expect(h.scheduleCalls).toBe(1)
    expect(h.webdavWrites).toHaveLength(0)
  })
})
