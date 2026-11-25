/** 日历日期工具：全部按浏览器本地时区，键统一为 YYYY-MM-DD。 */

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const CAL_PREFIX = 'cal:'

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → 本地日期键（不能用 toISOString，它是 UTC）。 */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function todayKey(): string {
  return toDateKey(new Date())
}

/** 校验并返回规范日期键；非法输入返回 null。 */
export function normalizeDateKey(value: string): string | null {
  const m = DATE_KEY_RE.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(year, month - 1, day)
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

export function dateKeyToDate(key: string): Date | null {
  const m = DATE_KEY_RE.exec(key)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 月份范围（month 为 1–12），供 PouchDB allDocs 前缀查询。 */
export function monthRange(year: number, month: number): { start: string; end: string } {
  const prefix = `${year}-${pad2(month)}`
  return { start: `${CAL_PREFIX}${prefix}-01:`, end: `${CAL_PREFIX}${prefix}-31:\uffff` }
}

export interface MonthCell {
  key: string
  day: number
  inMonth: boolean
  isToday: boolean
  weekday: number
}

/** 生成 6 周 × 7 天月视图网格，周一为一周起点。 */
export function buildMonthGrid(year: number, month: number, today: string = todayKey()): MonthCell[] {
  const first = new Date(year, month - 1, 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = new Date(year, month - 1, 1 - mondayOffset)
  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const key = toDateKey(d)
    cells.push({
      key,
      day: d.getDate(),
      inMonth: d.getMonth() === month - 1 && d.getFullYear() === year,
      isToday: key === today,
      weekday: (d.getDay() + 6) % 7,
    })
  }
  return cells
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month - 1 + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}
