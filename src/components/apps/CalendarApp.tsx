/**
 * 在线日历：月视图 + 选中日期的事件/记录。
 *
 * 数据存独立库 onenav-calendar（每条事件一个 cal: 文档），经 universal-sync-v2
 * 与 zen-fs-config v2 数据同步组的文件系统双向同步；不写主库。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import {
  buildMonthGrid,
  dateKeyToDate,
  normalizeDateKey,
  shiftMonth,
  todayKey,
} from '@/lib/calendar-date'
import { CALENDAR_CATEGORIES, categoryMeta, formatEventGap, searchCalendarEvents, type CalendarEvent } from '@/lib/calendar-model'
import { CALENDAR_SYNCED_EVENT } from '@/lib/calendar-sync'
import { loadAllEvents, putEvent, removeEvent } from '@/lib/calendar-store'
import CalendarSyncPanel from '@/components/apps/calendar/CalendarSyncPanel'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

type Draft = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

function emptyDraft(date: string): Draft {
  return {
    date,
    title: '',
    body: '',
    allDay: false,
    startTime: '',
    endTime: '',
    category: 'note',
    color: categoryMeta('note').color,
  }
}

function draftFromEvent(event: CalendarEvent): Draft {
  const { id, date, title, body, allDay, startTime, endTime, category, color } = event
  return { id, date, title, body, allDay, startTime, endTime, category, color }
}

function clockLabel(event: CalendarEvent): string {
  if (event.allDay) return '全天'
  if (!event.startTime) return '未设时间'
  return event.endTime ? `${event.startTime} – ${event.endTime}` : event.startTime
}

export default function CalendarApp() {
  const initial = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() + 1 })
  const [selectedDate, setSelectedDate] = useState(todayKey())
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const load = useCallback(async () => {
    try {
      setEvents(await loadAllEvents())
    } catch (e) {
      setNotice(`读取失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const onSynced = () => void load()
    window.addEventListener(CALENDAR_SYNCED_EVENT, onSynced)
    return () => window.removeEventListener(CALENDAR_SYNCED_EVENT, onSynced)
  }, [load])

  const cells = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor])
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const list = map.get(event.date) ?? []
      list.push(event)
      map.set(event.date, list)
    }
    return map
  }, [events])
  const selectedEvents = eventsByDate.get(selectedDate) ?? []
  const selectedWeekday = dateKeyToDate(selectedDate)
  const searchResults = useMemo(() => searchCalendarEvents(events, searchQuery), [events, searchQuery])

  const changeMonth = (delta: number) => setCursor((prev) => shiftMonth(prev.year, prev.month, delta))

  const jumpToEvent = (event: CalendarEvent) => {
    setSelectedDate(event.date)
    setCursor({ year: Number(event.date.slice(0, 4)), month: Number(event.date.slice(5, 7)) })
  }

  const save = async () => {
    if (!draft) return
    const date = normalizeDateKey(draft.date)
    if (!date || !draft.title.trim()) {
      setNotice('请填写有效日期和标题')
      return
    }
    setSaving(true)
    try {
      const saved = await putEvent({
        ...draft,
        date,
        title: draft.title.trim(),
        color: categoryMeta(draft.category).color,
      })
      setSelectedDate(saved.date)
      setCursor({ year: Number(saved.date.slice(0, 4)), month: Number(saved.date.slice(5, 7)) })
      setDraft(null)
      await load()
      setNotice('已保存')
    } catch (e) {
      setNotice(`保存失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (event: CalendarEvent) => {
    if (!window.confirm(`删除「${event.title}」？`)) return
    try {
      await removeEvent(event)
      await load()
      setNotice('已删除')
    } catch (e) {
      setNotice(`删除失败：${String(e)}`)
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4 space-y-4 text-white/90">
      {notice && (
        <div className="flex items-center justify-between rounded-lg bg-white/10 px-3 py-2 text-xs">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} aria-label="关闭提示">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <section className="rounded-xl bg-white/5 border border-white/10 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-white/40" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchQuery('')
            }}
            placeholder="搜索事件标题、内容、日期、分类…（空格分隔多个关键词）"
            aria-label="搜索日历事件"
            className="w-full rounded-lg bg-white/10 py-2 pl-9 pr-9 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              aria-label="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/80"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {searchQuery.trim() && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-white/50">
              找到 {searchResults.length} 条结果 · 按时间先后排列 · 点击结果定位到当天
            </p>
            {searchResults.length === 0 ? (
              <p className="py-4 text-center text-sm text-white/40">没有匹配的事件</p>
            ) : (
              <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {searchResults.map((event, index) => (
                  <Fragment key={event.id}>
                    {index > 0 && (
                      <li className="flex items-center gap-2 py-0.5 text-[11px] text-white/40" aria-hidden="true">
                        <span className="h-px flex-1 bg-white/10" />
                        <span>{formatEventGap(searchResults[index - 1], event)}</span>
                        <span className="h-px flex-1 bg-white/10" />
                      </li>
                    )}
                    <li className="flex items-start gap-1 rounded-lg bg-white/5 border border-white/10 p-2">
                      <button
                        onClick={() => jumpToEvent(event)}
                        title="定位到这一天"
                        className="min-w-0 flex-1 text-left hover:bg-white/5"
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: event.color }} />
                          <span className="font-medium">{event.title}</span>
                          <span className="text-xs text-white/40">
                            {event.date} · {clockLabel(event)} · {categoryMeta(event.category).label}
                          </span>
                        </div>
                        {event.body && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-white/60">{event.body}</p>}
                      </button>
                      <button
                        onClick={() => setDraft(draftFromEvent(event))}
                        aria-label="编辑此事件"
                        className="shrink-0 rounded p-1 hover:bg-white/10"
                      >
                        <Pencil className="w-3.5 h-3.5 text-white/50" />
                      </button>
                    </li>
                  </Fragment>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-xl bg-white/5 border border-white/10 p-4">
          <div className="mb-4 flex items-center justify-between">
            <button
              onClick={() => setCursor({ year: initial.getFullYear(), month: initial.getMonth() + 1 })}
              className="rounded-lg px-3 py-1 text-sm hover:bg-white/10"
            >
              今天
            </button>
            <div className="flex items-center gap-3">
              <button onClick={() => changeMonth(-1)} aria-label="上个月" className="rounded-lg p-1 hover:bg-white/10">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <h2 className="min-w-32 text-center text-lg font-medium">
                {cursor.year} 年 {cursor.month} 月
              </h2>
              <button onClick={() => changeMonth(1)} aria-label="下个月" className="rounded-lg p-1 hover:bg-white/10">
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            <button
              onClick={() => setDraft(emptyDraft(selectedDate))}
              className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1 text-sm hover:bg-sky-500"
            >
              <Plus className="w-4 h-4" /> 新增
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-xs text-white/50">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-1">周{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell) => {
              const dayEvents = eventsByDate.get(cell.key) ?? []
              const selected = cell.key === selectedDate
              return (
                <button
                  key={cell.key}
                  onClick={() => setSelectedDate(cell.key)}
                  className={`min-h-16 rounded-lg border p-1 text-left transition-colors ${
                    selected ? 'border-sky-400 bg-sky-500/20' : 'border-white/10 hover:bg-white/10'
                  } ${cell.inMonth ? '' : 'opacity-35'}`}
                >
                  <div className={`text-sm ${cell.isToday ? 'font-semibold text-sky-300' : ''}`}>{cell.day}</div>
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {dayEvents.slice(0, 4).map((event) => (
                      <span
                        key={event.id}
                        title={event.title}
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: event.color }}
                      />
                    ))}
                    {dayEvents.length > 4 && <span className="text-[11px] text-white/40">+{dayEvents.length - 4}</span>}
                  </div>
                </button>
              )
            })}
          </div>
          {loading && <p className="mt-3 text-xs text-white/40">正在读取本地事件…</p>}
        </section>

        <section className="rounded-xl bg-white/5 border border-white/10 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-base font-medium">
                <CalendarDays className="w-4 h-4 text-sky-300" />
                {selectedDate}
              </h3>
              <p className="text-xs text-white/40">{selectedWeekday ? WEEK_NAMES[selectedWeekday.getDay() === 0 ? 6 : selectedWeekday.getDay() - 1] : ''}</p>
            </div>
            <button
              onClick={() => setDraft(emptyDraft(selectedDate))}
              className="flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
            >
              <Plus className="w-3.5 h-3.5" /> 记录
            </button>
          </div>

          {selectedEvents.length === 0 ? (
            <p className="py-8 text-center text-sm text-white/40">这一天还没有事件或记录</p>
          ) : (
            <ul className="space-y-2">
              {selectedEvents.map((event) => (
                <li key={event.id} className="rounded-lg bg-white/5 border border-white/10 p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: event.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{event.title}</span>
                        <span className="flex shrink-0 gap-1">
                          <button onClick={() => setDraft(draftFromEvent(event))} aria-label="编辑" className="rounded p-1 hover:bg-white/10">
                            <Pencil className="w-3.5 h-3.5 text-white/60" />
                          </button>
                          <button onClick={() => void remove(event)} aria-label="删除" className="rounded p-1 hover:bg-white/10">
                            <Trash2 className="w-3.5 h-3.5 text-rose-300" />
                          </button>
                        </span>
                      </div>
                      <p className="mt-1 flex items-center gap-1 text-xs text-white/50">
                        <Clock className="w-3 h-3" /> {clockLabel(event)} · {categoryMeta(event.category).label}
                      </p>
                      {event.body && <p className="mt-2 whitespace-pre-wrap text-sm text-white/70">{event.body}</p>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <CalendarSyncPanel onReady={() => void load()} />

      {draft && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDraft(null)
          }}
        >
          <div className="w-full max-w-lg rounded-xl bg-slate-900 border border-white/15 p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-medium">{draft.id ? '编辑事件' : '新增事件 / 记录'}</h3>
              <button onClick={() => setDraft(null)} aria-label="关闭" className="rounded p-1 hover:bg-white/10">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-white/60">
                  日期
                  <input
                    type="date"
                    value={draft.date}
                    onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                    className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white [color-scheme:dark]"
                  />
                </label>
                <label className="block text-xs text-white/60">
                  分类
                  <select
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                    className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white [color-scheme:dark]"
                  >
                    {CALENDAR_CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-xs text-white/60">
                标题
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="这一天要做什么 / 发生了什么"
                  className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30"
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.allDay}
                  onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })}
                  className="h-4 w-4 accent-sky-500"
                />
                全天
              </label>
              {!draft.allDay && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs text-white/60">
                    开始时间
                    <input
                      type="time"
                      value={draft.startTime}
                      onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                      className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white [color-scheme:dark]"
                    />
                  </label>
                  <label className="block text-xs text-white/60">
                    结束时间
                    <input
                      type="time"
                      value={draft.endTime}
                      onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                      className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-white [color-scheme:dark]"
                    />
                  </label>
                </div>
              )}
              <label className="block text-xs text-white/60">
                内容
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={5}
                  placeholder="记录细节、备忘、链接…"
                  className="mt-1 w-full resize-y rounded-lg bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30"
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setDraft(null)} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20">
                取消
              </button>
              <button
                onClick={() => void save()}
                disabled={saving}
                className="flex items-center gap-1 rounded-lg bg-sky-600 px-4 py-2 text-sm hover:bg-sky-500 disabled:opacity-50"
              >
                <Check className="w-4 h-4" /> {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
