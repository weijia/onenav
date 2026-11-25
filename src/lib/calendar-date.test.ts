import { describe, it, expect } from 'vitest'
import { buildMonthGrid, normalizeDateKey, shiftMonth, toDateKey } from './calendar-date'

describe('日历日期工具', () => {
  it('按本地时区生成 YYYY-MM-DD，不因 UTC 偏移跨天', () => {
    expect(toDateKey(new Date(2026, 10, 25, 23, 30))).toBe('2026-11-25')
    expect(toDateKey(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })

  it('拒绝不存在的日期', () => {
    expect(normalizeDateKey('2026-11-25')).toBe('2026-11-25')
    expect(normalizeDateKey('2026-02-30')).toBeNull()
    expect(normalizeDateKey('2026/11/25')).toBeNull()
  })

  it('月视图网格固定 42 格，周一起始', () => {
    const cells = buildMonthGrid(2026, 11, '2026-11-25')
    expect(cells).toHaveLength(42)
    expect(cells[0].weekday).toBe(0)
    expect(cells[0].key).toBe('2026-10-26')
    expect(cells.filter((c) => c.isToday).map((c) => c.key)).toEqual(['2026-11-25'])
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30)
  })

  it('跨年切月', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
  })
})
