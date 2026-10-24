/**
 * 记账「价格记录」的合并策略。
 *
 * 去重规则（按商品名 + 时间粒度）：
 *  - 记录携带完整日期时间（time，HH:MM:SS）→ 去重键 = 商品名 + 日期时间（同一天不同时间点的报价各自保留）；
 *  - 记录只有日期（date）→ 去重键 = 商品名 + 日期（同一天同名只留一条，跨日期各自保留）。
 * 即：取该记录携带的最细时间作为去重粒度；同一去重键内保留最新（date 降序 → time 降序 → createdAt 降序）。
 *
 * 背景：旧实现按 `kind + 商品名` 去重、同名只保留最新一条；后又临时改为「完全不去重」。
 * 最终按用户确认的规则实现为「商品名 + 时间粒度」去重，保留同名商品在不同时间/日期的报价历史，
 * 同时避免同一时间粒度内（如同一订单/同一天）的重复膨胀。
 */
import type { PriceRecord } from './bookkeeping-store'

export type MergeMode = 'merge' | 'replace'

/** 取商品显示名：item 用 product，其余 kind 用 name */
function productNameOf(r: PriceRecord): string {
  return r.kind === 'item' ? r.product : r.name
}

/** 时间粒度感知去重键：优先 time（日期时间），否则 date（日期）。 */
function keyOf(r: PriceRecord): string {
  const name = productNameOf(r).toLowerCase()
  return `${r.kind}:${name}:${r.time ?? r.date}`
}

/** 新旧判断：date 更新，或同日 time 更新，或同日同时 createdAt 更新。 */
function isNewerThan(a: PriceRecord, b: PriceRecord): boolean {
  if (a.date !== b.date) return a.date > b.date
  const ta = a.time ?? ''
  const tb = b.time ?? ''
  if (ta !== tb) return ta > tb
  return a.createdAt >= b.createdAt
}

/**
 * 合并价格记录：按「商品名 + 时间粒度」去重，同一去重键保留最新。
 * - mode='merge'：prev + incoming 一起按去重键合并（同名同时/同日去重，跨时间/日期各自保留）；
 * - mode='replace'：忽略 prev，只用 incoming 去重（替换全部）。
 * 输出按 date 降序 → time 降序 → createdAt 降序。
 */
export function mergePrices(prev: PriceRecord[], incoming: PriceRecord[], mode: MergeMode): PriceRecord[] {
  const source = mode === 'merge' ? [...prev, ...incoming] : [...incoming]
  const byKey = new Map<string, PriceRecord>()
  for (const r of source) {
    const k = keyOf(r)
    const ex = byKey.get(k)
    if (!ex || isNewerThan(r, ex)) byKey.set(k, r)
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    const ta = a.time ?? ''
    const tb = b.time ?? ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return b.createdAt - a.createdAt
  })
}
