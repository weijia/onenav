import { describe, expect, it } from 'vitest'
import {
  AI_PROMPT,
  orderFilePath,
  orderMonthDir,
  orderTotal,
  parseImportText,
  normalizeOrder,
  SAMPLE_ORDER,
} from './format'

describe('normalizeOrder', () => {
  it('归一化完整记录', () => {
    const res = normalizeOrder(SAMPLE_ORDER, 1000)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.order.date).toBe('2026-11-19')
    expect(res.order.items).toHaveLength(3)
    expect(res.order.items[1].qty).toBe(2)
    expect(res.order.total).toBe(44)
    expect(res.order.source).toBe('import')
    expect(res.order.id).toMatch(/^2026-11-19-/)
  })

  it('价格缺失填 null 并给出警告，不编造', () => {
    const res = normalizeOrder({ date: '2026-01-02', items: [{ name: '无名菜' }] }, 1000)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.order.items[0].price).toBeNull()
    expect(res.order.items[0].qty).toBe(1)
    expect(res.order.total).toBeNull()
    if (res.ok) expect(res.warnings.some((w) => w.includes('无价格'))).toBe(true)
  })

  it('接受带货币符号的价格字符串', () => {
    const res = normalizeOrder({ items: [{ name: '菜', price: '¥1,288.50' }] }, 1000)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.order.items[0].price).toBe(1288.5)
  })

  it('拒绝非法日期与空菜品', () => {
    expect(normalizeOrder({ date: '2026-02-30', items: [{ name: 'x' }] }).ok).toBe(false)
    expect(normalizeOrder({ items: [] }).ok).toBe(false)
    expect(normalizeOrder({ items: [{ qty: 1 }] }).ok).toBe(false)
  })

  it('同一内容生成稳定 id（可去重）', () => {
    const a = normalizeOrder(SAMPLE_ORDER, 1)
    const b = normalizeOrder(SAMPLE_ORDER, 999999)
    expect(a.ok && b.ok && a.order.id === b.order.id).toBe(true)
  })
})

describe('parseImportText', () => {
  it('解析单对象、数组与逐行 JSON', () => {
    expect(parseImportText('{"items":[{"name":"x"}]}')).toHaveLength(1)
    expect(parseImportText('[{"a":1},{"a":2}]')).toHaveLength(2)
    expect(parseImportText('{"a":1}\n{"a":2}')).toHaveLength(2)
  })

  it('兼容 AI 输出的代码围栏', () => {
    const fenced = '```json\n{"items":[{"name":"x"}]}\n```'
    expect(parseImportText(fenced)).toHaveLength(1)
    const withPreamble = '好的，这是点菜记录：\n```json\n[{"a":1},{"a":2}]\n```\n希望有帮助。'
    expect(parseImportText(withPreamble)).toHaveLength(2)
  })

  it('无效 JSON 抛错', () => {
    expect(() => parseImportText('not json')).toThrow(/JSON 解析失败/)
  })
})

describe('分片路径与合计', () => {
  it('按月分片路径', () => {
    const res = normalizeOrder(SAMPLE_ORDER, 1)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(orderMonthDir(res.order)).toBe('/orders/2026/11')
    expect(orderFilePath(res.order)).toBe(`/orders/2026/11/${res.order.id}.json`)
  })

  it('合计优先 total，缺失则累加有价格菜品', () => {
    const a = normalizeOrder(SAMPLE_ORDER, 1)
    expect(a.ok && orderTotal(a.order)).toBe(44)
    const b = normalizeOrder({ items: [{ name: 'a', price: 10, qty: 2 }, { name: 'b' }] }, 1)
    expect(b.ok && orderTotal(b.order)).toBe(20)
  })
})

describe('AI 提示词', () => {
  it('包含示例与 photo-agent 来源约定', () => {
    expect(AI_PROMPT).toContain('宫保鸡丁')
    expect(AI_PROMPT).toContain('"photo-agent"')
    expect(AI_PROMPT).toContain('不要')
  })
})
