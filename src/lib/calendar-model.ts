/** 日历事件的纯数据模型：分类色板、排序规则。无浏览器依赖，便于单测。 */

export interface CalendarEvent {
  id: string
  date: string // YYYY-MM-DD（本地日期）
  title: string
  body: string
  allDay: boolean
  startTime: string // HH:MM，allDay 时为空
  endTime: string // HH:MM，allDay 时为空
  category: string
  color: string // 分类色板的 hex 值
  createdAt: number
  updatedAt: number
}

export interface CalendarCategory {
  id: string
  label: string
  color: string
}

export const CALENDAR_CATEGORIES: CalendarCategory[] = [
  { id: 'work', label: '工作', color: '#38bdf8' },
  { id: 'life', label: '生活', color: '#34d399' },
  { id: 'note', label: '记录', color: '#fbbf24' },
  { id: 'other', label: '其他', color: '#a78bfa' },
]

export function categoryMeta(id: string): CalendarCategory {
  return CALENDAR_CATEGORIES.find((c) => c.id === id) ?? CALENDAR_CATEGORIES[CALENDAR_CATEGORIES.length - 1]
}

/**
 * 按关键词搜索事件。空格分隔多个词，全部命中才算匹配（AND）。
 * 匹配范围：标题、正文、日期（YYYY-MM-DD）、分类名/id、时间；大小写不敏感。
 */
export function searchCalendarEvents(events: CalendarEvent[], query: string): CalendarEvent[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  return events
    .filter((event) => {
      const haystack = [
        event.title,
        event.body,
        event.date,
        categoryMeta(event.category).label,
        event.category,
        event.allDay ? '全天' : '',
        event.startTime,
        event.endTime,
      ]
        .join(' ')
        .toLowerCase()
      return tokens.every((token) => haystack.includes(token))
    })
    .sort(compareEvents)
}

/** 事件开始时刻（本地时区）；全天/未设时间按当天 00:00 计算。 */
export function eventStartAt(event: CalendarEvent): number {
  const [year, month, day] = event.date.split('-').map(Number)
  const [hour, minute] = (event.allDay ? '00:00' : event.startTime || '00:00').split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute).getTime()
}

/** 两个按时间排序的事件之间的间隔，用于搜索结果时间轴。 */
export function formatEventGap(previous: CalendarEvent, next: CalendarEvent): string {
  const diff = eventStartAt(next) - eventStartAt(previous)
  if (diff <= 0) return previous.date === next.date ? '同一天' : '同一时刻'
  const totalMinutes = Math.round(diff / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `相隔 ${days} 天${hours ? ` ${hours} 小时` : ''}`
  if (hours > 0) return `相隔 ${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}`
  return `相隔 ${minutes} 分钟`
}

/** 同一天内：全天事件在前，再按开始时间、创建时间排。 */
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const date = a.date.localeCompare(b.date)
  if (date !== 0) return date
  const at = a.allDay ? '' : a.startTime
  const bt = b.allDay ? '' : b.startTime
  const time = at.localeCompare(bt)
  if (time !== 0) return time
  return a.createdAt - b.createdAt
}
