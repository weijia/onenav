import { describe, it, expect } from 'vitest'
import { searchCalendarEvents, type CalendarEvent } from './calendar-model'

function event(partial: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'date' | 'title'>): CalendarEvent {
  return {
    body: '',
    allDay: true,
    startTime: '',
    endTime: '',
    category: 'note',
    color: '#fbbf24',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

const EVENTS: CalendarEvent[] = [
  event({ id: 'a', date: '2026-11-25', title: '周会', body: '讨论日历搜索功能', category: 'work' }),
  event({ id: 'b', date: '2026-11-26', title: '买菜', body: '晚上做番茄牛腩', category: 'life', allDay: false, startTime: '18:30', endTime: '19:00' }),
  event({ id: 'c', date: '2026-12-01', title: '读书笔记', body: '《设计数据密集型应用》', category: 'note' }),
]

describe('searchCalendarEvents', () => {
  it('空关键词不返回结果', () => {
    expect(searchCalendarEvents(EVENTS, '')).toEqual([])
    expect(searchCalendarEvents(EVENTS, '   ')).toEqual([])
  })

  it('标题与正文均大小写不敏感匹配', () => {
    expect(searchCalendarEvents(EVENTS, '日历').map((e) => e.id)).toEqual(['a'])
    expect(searchCalendarEvents(EVENTS, '番茄').map((e) => e.id)).toEqual(['b'])
  })

  it('多个关键词需全部命中', () => {
    expect(searchCalendarEvents(EVENTS, '讨论 日历').map((e) => e.id)).toEqual(['a'])
    expect(searchCalendarEvents(EVENTS, '讨论 番茄')).toEqual([])
  })

  it('可按日期、分类或时间搜索', () => {
    expect(searchCalendarEvents(EVENTS, '2026-12').map((e) => e.id)).toEqual(['c'])
    expect(searchCalendarEvents(EVENTS, '生活').map((e) => e.id)).toEqual(['b'])
    expect(searchCalendarEvents(EVENTS, '18:30').map((e) => e.id)).toEqual(['b'])
  })

  it('结果按日期/时间排序', () => {
    const shuffled = [EVENTS[2], EVENTS[0], EVENTS[1]]
    expect(searchCalendarEvents(shuffled, '2026').map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})
