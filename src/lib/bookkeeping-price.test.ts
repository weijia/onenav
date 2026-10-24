// 价格记录合并策略（bookkeeping-price）行为验证测试。
//
// 去重规则（按商品名 + 时间粒度）：
//  - 记录携带日期时间（time，HH:MM:SS）→ 去重键 = 商品名 + 日期时间（同一天不同时间点的报价各自保留）；
//  - 记录只有日期（date）→ 去重键 = 商品名 + 日期（同一天同名只留一条，跨日期各自保留）。
// 即：取记录携带的最细时间作为去重粒度；同一去重键内保留最新。
// 本测试验证这些规则、merge/replace 语义与排序。
// 不修改业务源码之外的逻辑，仅新增本测试。

import { describe, it, expect } from 'vitest'
import { mergePrices } from './bookkeeping-price'
import { priceTotalOf } from './bookkeeping-store'
import type { PriceRecord } from './bookkeeping-store'

function makeItem(id: string, product: string, date: string, createdAt: number, time?: string, unitPrice = 5): PriceRecord {
  const r: PriceRecord = { type: 'price', kind: 'item', id, product, unit: '斤', unitPrice, date, createdAt }
  if (time) r.time = time
  return r
}

describe('mergePrices（商品名 + 时间粒度 去重）', () => {
  it('E-1 同名不同日期（只有日期）→ 各自保留，不覆盖，date 降序', () => {
    const incoming = [
      makeItem('a1', '鸡蛋', '2026-10-20', 1),
      makeItem('a2', '鸡蛋', '2026-10-24', 1),
    ]
    const out = mergePrices([], incoming, 'replace')
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.id).sort()).toEqual(['a1', 'a2'])
    expect(out[0].id).toBe('a2') // 2026-10-24 在前
    expect(out[1].id).toBe('a1')
  })

  it('E-2 同名同日期、无 time → 按「商品名+日期」去重，只留最新一条（createdAt 大者）', () => {
    const incoming = [
      makeItem('a1', '鸡蛋', '2026-10-24', 1),
      makeItem('a2', '鸡蛋', '2026-10-24', 2),
    ]
    const out = mergePrices([], incoming, 'replace')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a2')
  })

  it('E-3 同名同日期、不同 time（日期时间）→ 各自保留，time 降序', () => {
    const incoming = [
      makeItem('a1', '鸡蛋', '2026-10-24', 1, '08:00:00'),
      makeItem('a2', '鸡蛋', '2026-10-24', 2, '20:00:00'),
    ]
    const out = mergePrices([], incoming, 'replace')
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('a2') // 20:00 在前
    expect(out[1].id).toBe('a1')
  })

  it('E-4 同名同日期同 time → 按「商品名+日期时间」去重，只留最新一条（createdAt 大者）', () => {
    const incoming = [
      makeItem('a1', '鸡蛋', '2026-10-24', 1, '08:00:00'),
      makeItem('a2', '鸡蛋', '2026-10-24', 2, '08:00:00'),
    ]
    const out = mergePrices([], incoming, 'replace')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a2')
  })

  it('E-5 同名同日期，一条带 time、一条无 time → 键不同，各自保留', () => {
    const incoming = [
      makeItem('a1', '鸡蛋', '2026-10-24', 1), // 键 = 商品名:2026-10-24
      makeItem('a2', '鸡蛋', '2026-10-24', 2, '09:30:00'), // 键 = 商品名:2026-10-24 09:30:00
    ]
    const out = mergePrices([], incoming, 'replace')
    expect(out).toHaveLength(2)
  })

  it('E-6 mode=merge：现有 + 导入按去重键合并（跨日期各自保留）', () => {
    const prev = [makeItem('a1', '鸡蛋', '2026-10-20', 1)]
    const incoming = [makeItem('a2', '鸡蛋', '2026-10-24', 2)]
    const out = mergePrices(prev, incoming, 'merge')
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.id).sort()).toEqual(['a1', 'a2'])
  })

  it('E-7 mode=merge：同键记录被更新替代（不重复保留）', () => {
    const prev = [makeItem('a1', '鸡蛋', '2026-10-24', 1)]
    const incoming = [makeItem('a2', '鸡蛋', '2026-10-24', 2)] // 同日期同商品 → 同键，保留新的
    const out = mergePrices(prev, incoming, 'merge')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a2')
  })

  it('E-8 mode=replace：忽略现有，只用导入去重（替换全部）', () => {
    const prev = [makeItem('a0', '鸡蛋', '2026-10-01', 0)]
    const incoming = [makeItem('a2', '鸡蛋', '2026-10-24', 2)]
    const out = mergePrices(prev, incoming, 'replace')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a2')
  })

  it('E-9 排序：date 降序 → time 降序 → createdAt 降序', () => {
    const incoming = [
      makeItem('a1', '鸡蛋', '2026-10-24', 1, '10:00:00'),
      makeItem('a2', '鸡蛋', '2026-10-24', 5, '08:00:00'), // date 同、time 更早 → 排后
      makeItem('a3', '鸡蛋', '2026-10-23', 9),
      makeItem('a4', '牛奶', '2026-10-24', 3, '12:00:00'),
    ]
    const out = mergePrices([], incoming, 'replace')
    expect(out.map((r) => r.id)).toEqual(['a4', 'a1', 'a2', 'a3']) // date 降序；同 date 按 time 降序
  })
})

describe('priceTotalOf（单价 × 数量 = 整体价）', () => {
  it('F-1 有数量 → 整体价 = 单价 × 数量', () => {
    const r: PriceRecord = { type: 'price', kind: 'item', id: 'x', product: '鸡蛋', unit: '箱', unitPrice: 30, quantity: 1, date: '2026-10-24', createdAt: 1 }
    expect(priceTotalOf(r)).toBe(30)
    const r2: PriceRecord = { type: 'price', kind: 'item', id: 'y', product: '鸡蛋', unit: '斤', unitPrice: 3, quantity: 5, date: '2026-10-24', createdAt: 1 }
    expect(priceTotalOf(r2)).toBe(15)
  })

  it('F-2 无数量 → 整体价即单价', () => {
    const r: PriceRecord = { type: 'price', kind: 'item', id: 'z', product: '苹果', unit: '斤', unitPrice: 6.5, date: '2026-10-24', createdAt: 1 }
    expect(priceTotalOf(r)).toBe(6.5)
  })

  it('F-3 数量为 0 / 负数 → 视作无数量，返回单价', () => {
    const r: PriceRecord = { type: 'price', kind: 'item', id: 'q', product: '鸡蛋', unit: '斤', unitPrice: 3, quantity: 0, date: '2026-10-24', createdAt: 1 }
    expect(priceTotalOf(r)).toBe(3)
  })

  it('F-4 单价×数量保留两位小数（浮点精度）', () => {
    const r: PriceRecord = { type: 'price', kind: 'item', id: 'p', product: '牛肉', unit: '斤', unitPrice: 33.3, quantity: 3, date: '2026-10-24', createdAt: 1 }
    expect(priceTotalOf(r)).toBe(99.9)
  })
})
