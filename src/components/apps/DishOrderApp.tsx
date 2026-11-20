/**
 * 点菜助手主界面。
 *
 * 功能：
 *  - 数据同步组连接引导（DishOrderSyncPanel）；
 *  - 导入：粘贴 JSON / 上传 .json → 解析校验 → 预览表格 → 确认写入（跳过/覆盖重复）；
 *  - 记录：月份筛选 + 搜索 + 卡片列表 + 展开菜品明细（数量×单价小计）+ 删除确认；
 *  - 手动新增一条记录（价格可留空）；
 *  - AI 提示词面板：一键复制给多模态 Agent，从照片生成可直接导入的 JSON。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  AI_PROMPT,
  itemSubtotal,
  normalizeOrder,
  orderTotal,
  parseImportText,
} from './dish-order/format'
import type { DishOrder, NormalizeResult } from './dish-order/format'
import DishOrderSyncPanel from './dish-order/DishOrderSyncPanel'
import {
  deleteOrder,
  isDishGroupReady,
  listMonths,
  readOrders,
  writeOrder,
  writeOrders,
} from './dish-order/store'

// ───────────────────────────────────────────────────────────
// 小工具
// ───────────────────────────────────────────────────────────

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function money(n: number | null): string {
  if (n === null) return '—'
  return `¥${Number.isInteger(n) ? n : n.toFixed(2)}`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ───────────────────────────────────────────────────────────
// 导入
// ───────────────────────────────────────────────────────────

interface PreviewRow {
  index: number
  raw: unknown
  result: NormalizeResult
}

type DuplicatePolicy = 'skip' | 'overwrite'

interface ImportPanelProps {
  onImported: () => void
  disabled: boolean
}

function ImportPanel({ onImported, disabled }: ImportPanelProps) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [parseError, setParseError] = useState('')
  const [policy, setPolicy] = useState<DuplicatePolicy>('skip')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setText('')
    setPreview(null)
    setParseError('')
    setResult('')
  }

  const doPreview = () => {
    setParseError('')
    setResult('')
    try {
      const raws = parseImportText(text)
      if (raws.length === 0) {
        setPreview(null)
        setParseError('没有解析到记录')
        return
      }
      setPreview(
        raws.map((raw, i) => ({
          index: i + 1,
          raw,
          result: normalizeOrder(raw),
        })),
      )
    } catch (e) {
      setPreview(null)
      setParseError(errText(e))
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const content = await file.text()
      setText(content)
      setParseError('')
      setPreview(null)
      setResult('')
    } catch (e) {
      setParseError(`读取文件失败：${errText(e)}`)
    }
  }

  const okCount = preview?.filter((r) => r.result.ok).length ?? 0
  const errCount = preview?.filter((r) => !r.result.ok).length ?? 0

  const doImport = async () => {
    if (!preview || okCount === 0) return
    setBusy(true)
    setResult('')
    try {
      const orders: DishOrder[] = []
      for (const row of preview) {
        if (row.result.ok) orders.push(row.result.order)
      }
      const res = await writeOrders(orders, policy === 'overwrite')
      setResult(`已写入 ${res.written} 条${res.skipped ? `，跳过重复 ${res.skipped} 条` : ''}`)
      setPreview(null)
      setText('')
      onImported()
    } catch (e) {
      setResult(`导入失败：${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg bg-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2">
          <ClipboardPaste className="w-4 h-4" /> 导入点菜记录
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/20 disabled:opacity-40"
          >
            <Upload className="w-3.5 h-3.5" /> 上传 .json
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button onClick={reset} className="rounded px-2 py-1 text-xs text-white/50 hover:text-white/80">
            清空
          </button>
        </div>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'粘贴 AI Agent 生成的 JSON（单条对象或数组），例如：\n{ "date": "2026-11-19", "items": [{ "name": "宫保鸡丁", "price": 38 }] }'}
        className="w-full h-32 rounded bg-black/20 border border-white/10 px-3 py-2 text-xs font-mono text-white/90 placeholder-white/30 outline-none focus:border-white/30"
      />

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={doPreview}
          disabled={disabled || !text.trim()}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
        >
          解析并预览
        </button>
        <label className="flex items-center gap-1 text-xs text-white/60">
          重复记录：
          <select
            value={policy}
            onChange={(e) => setPolicy(e.target.value as DuplicatePolicy)}
            className="rounded bg-white/10 px-2 py-1 text-white/90 outline-none"
          >
            <option value="skip">跳过</option>
            <option value="overwrite">覆盖</option>
          </select>
        </label>
        {preview && (
          <span className="text-xs text-white/60">
            预览 {preview.length} 条 · <span className="text-emerald-400">{okCount} 条可导入</span>
            {errCount > 0 && <span className="text-red-400"> · {errCount} 条有误</span>}
          </span>
        )}
      </div>

      {parseError && (
        <p className="flex items-start gap-1.5 text-xs text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {parseError}
        </p>
      )}

      {preview && (
        <div className="max-h-72 overflow-auto rounded border border-white/10">
          <table className="w-full text-xs text-left">
            <thead className="sticky top-0 bg-white/10 text-white/60">
              <tr>
                <th className="px-2 py-1.5">#</th>
                <th className="px-2 py-1.5">日期 / 餐次</th>
                <th className="px-2 py-1.5">店名</th>
                <th className="px-2 py-1.5">菜品</th>
                <th className="px-2 py-1.5">合计</th>
                <th className="px-2 py-1.5">状态</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => {
                if (!row.result.ok) {
                  return (
                    <tr key={row.index} className="border-t border-white/5 bg-red-500/5">
                      <td className="px-2 py-1.5 text-white/40">{row.index}</td>
                      <td colSpan={4} className="px-2 py-1.5 text-red-300">{row.result.error}</td>
                      <td className="px-2 py-1.5 text-red-400">错误</td>
                    </tr>
                  )
                }
                const o = row.result.order
                return (
                  <tr key={row.index} className="border-t border-white/5">
                    <td className="px-2 py-1.5 text-white/40">{row.index}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{o.date}{o.meal ? ` · ${o.meal}` : ''}</td>
                    <td className="px-2 py-1.5">{o.restaurant ?? '—'}</td>
                    <td className="px-2 py-1.5 text-white/70">
                      {o.items.map((it) => `${it.name}×${it.qty}`).join('、')}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{money(orderTotal(o))}</td>
                    <td className="px-2 py-1.5">
                      {row.result.warnings.length > 0 ? (
                        <span className="text-amber-300" title={row.result.warnings.join('；')}>
                          ⚠ {row.result.warnings.length} 项无价格
                        </span>
                      ) : (
                        <span className="text-emerald-400">就绪</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {preview && okCount > 0 && (
        <button
          onClick={() => void doImport()}
          disabled={disabled || busy}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy ? '写入中…' : `确认导入 ${okCount} 条`}
        </button>
      )}
      {result && <p className="text-xs text-sky-300">{result}</p>}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// 手动新增
// ───────────────────────────────────────────────────────────

interface DraftItem {
  name: string
  qty: string
  unit: string
  price: string
  note: string
}

const emptyDraftItem = (): DraftItem => ({ name: '', qty: '1', unit: '', price: '', note: '' })

function ManualAddPanel({ onAdded, disabled }: { onAdded: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(localToday())
  const [meal, setMeal] = useState('')
  const [restaurant, setRestaurant] = useState('')
  const [people, setPeople] = useState('')
  const [note, setNote] = useState('')
  const [total, setTotal] = useState('')
  const [items, setItems] = useState<DraftItem[]>([emptyDraftItem()])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const setItem = (i: number, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }

  const save = async () => {
    setError('')
    const raw = {
      date,
      meal: meal.trim() || undefined,
      restaurant: restaurant.trim() || undefined,
      people: people ? Number(people) : undefined,
      note: note.trim() || undefined,
      total: total ? Number(total) : null,
      source: 'manual',
      items: items
        .filter((it) => it.name.trim())
        .map((it) => ({
          name: it.name.trim(),
          qty: it.qty ? Number(it.qty) : 1,
          unit: it.unit.trim() || undefined,
          price: it.price ? Number(it.price) : null,
          note: it.note.trim() || undefined,
        })),
    }
    const res = normalizeOrder(raw)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setBusy(true)
    try {
      await writeOrder(res.order)
      setDate(localToday())
      setMeal('')
      setRestaurant('')
      setPeople('')
      setNote('')
      setTotal('')
      setItems([emptyDraftItem()])
      setOpen(false)
      onAdded()
    } catch (e) {
      setError(`保存失败：${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'rounded bg-white/10 px-2.5 py-1.5 text-sm text-white/90 placeholder-white/30 outline-none focus:bg-white/15'

  return (
    <div className="rounded-lg bg-white/5 p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="flex items-center gap-2 font-medium disabled:opacity-40"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        手动新增一条
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <label className="flex flex-col gap-1 text-xs text-white/60">
              日期
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              餐次
              <input value={meal} onChange={(e) => setMeal(e.target.value)} placeholder="晚餐" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              店名
              <input value={restaurant} onChange={(e) => setRestaurant(e.target.value)} placeholder="店名" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              人数
              <input type="number" min="1" value={people} onChange={(e) => setPeople(e.target.value)} placeholder="3" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              总额（可空）
              <input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="自动按菜品算" className={inputCls} />
            </label>
          </div>

          <div className="space-y-2">
            <div className="text-xs text-white/60">菜品（价格可留空）</div>
            {items.map((it, i) => (
              <div key={i} className="flex flex-wrap gap-2 items-center">
                <input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder="菜名" className={`${inputCls} flex-1 min-w-32`} />
                <input type="number" min="0.001" step="0.001" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} title="数量" className={`${inputCls} w-16`} />
                <input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} placeholder="份" className={`${inputCls} w-14`} />
                <input type="number" min="0" step="0.01" value={it.price} onChange={(e) => setItem(i, { price: e.target.value })} placeholder="单价" className={`${inputCls} w-20`} />
                <input value={it.note} onChange={(e) => setItem(i, { note: e.target.value })} placeholder="备注" className={`${inputCls} w-24`} />
                <button
                  onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={items.length === 1}
                  title="删除该行"
                  className="text-white/40 hover:text-red-400 disabled:opacity-30"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button
              onClick={() => setItems((prev) => [...prev, emptyDraftItem()])}
              className="flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200"
            >
              <Plus className="w-3.5 h-3.5" /> 添加菜品
            </button>
          </div>

          <label className="flex flex-col gap-1 text-xs text-white/60">
            整单备注
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" className={inputCls} />
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存记录'}
          </button>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// 记录卡片
// ───────────────────────────────────────────────────────────

function OrderCard({ order, onDelete }: { order: DishOrder; onDelete: (o: DishOrder) => void }) {
  const [expanded, setExpanded] = useState(false)
  const total = orderTotal(order)

  return (
    <div className="rounded-lg bg-white/5 border border-white/10 overflow-hidden">
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5">
        {expanded ? <ChevronDown className="w-4 h-4 text-white/40 shrink-0" /> : <ChevronRight className="w-4 h-4 text-white/40 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white/90 font-medium">{order.date}</span>
            {order.meal && <span className="rounded bg-sky-500/20 text-sky-300 text-xs px-1.5 py-0.5">{order.meal}</span>}
            {order.restaurant && <span className="text-white/70 text-sm truncate">{order.restaurant}</span>}
            {order.source === 'photo-agent' && <span className="rounded bg-purple-500/20 text-purple-300 text-xs px-1.5 py-0.5">照片</span>}
          </div>
          <div className="text-xs text-white/50 mt-1 truncate">
            {order.items.length} 道菜{order.people ? ` · ${order.people} 人` : ''}
            {' · '}
            {order.items.slice(0, 4).map((it) => it.name).join('、')}
            {order.items.length > 4 ? '…' : ''}
          </div>
        </div>
        <span className="text-emerald-300 font-medium whitespace-nowrap">{money(total)}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t border-white/10">
          <table className="w-full text-sm mt-2">
            <thead className="text-white/50 text-xs">
              <tr>
                <th className="text-left py-1">菜名</th>
                <th className="text-right py-1">数量</th>
                <th className="text-right py-1">单价</th>
                <th className="text-right py-1">小计</th>
                <th className="text-left py-1 pl-3">备注</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it, i) => (
                <tr key={i} className="border-t border-white/5 text-white/80">
                  <td className="py-1.5">{it.name}</td>
                  <td className="text-right py-1.5">{it.qty}{it.unit ?? ''}</td>
                  <td className="text-right py-1.5">{money(it.price)}</td>
                  <td className="text-right py-1.5">{money(itemSubtotal(it))}</td>
                  <td className="py-1.5 pl-3 text-white/50 text-xs">{it.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-white/10">
              <tr className="text-white/90">
                <td className="py-2" colSpan={3}>合计{order.total === null && <span className="text-white/40 text-xs">（按有价菜品累加）</span>}</td>
                <td className="text-right py-2 font-medium">{money(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {order.note && <p className="text-xs text-white/50 mt-1">备注：{order.note}</p>}
          <div className="flex justify-end mt-2">
            <button
              onClick={() => {
                if (window.confirm(`确定删除 ${order.date} 的这条点菜记录吗？`)) onDelete(order)
              }}
              className="flex items-center gap-1 text-xs text-white/50 hover:text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" /> 删除
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────
// 提示词面板
// ───────────────────────────────────────────────────────────

function PromptPanel() {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用（非安全上下文等）：选中文本让用户手动复制
      const ta = document.getElementById('dish-ai-prompt') as HTMLTextAreaElement | null
      ta?.select()
    }
  }

  return (
    <details className="rounded-lg bg-white/5 p-4">
      <summary className="cursor-pointer font-medium flex items-center gap-2">
        <Copy className="w-4 h-4" /> AI 提示词（照片 → 点菜记录 JSON）
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-white/60">
          把照片发给支持图片识别的 AI Agent，先粘贴下面这段提示词，让它输出 JSON；复制结果回到上方「导入」粘贴即可。
        </p>
        <button
          onClick={() => void copy()}
          className="flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? '已复制' : '复制提示词'}
        </button>
        <textarea
          id="dish-ai-prompt"
          readOnly
          value={AI_PROMPT}
          className="w-full h-64 rounded bg-black/20 border border-white/10 px-3 py-2 text-xs font-mono text-white/70 outline-none"
        />
      </div>
    </details>
  )
}

// ───────────────────────────────────────────────────────────
// 主组件
// ───────────────────────────────────────────────────────────

type LoadState = 'loading' | 'not-connected' | 'data'

export default function DishOrderApp() {
  const [state, setState] = useState<LoadState>('loading')
  const [orders, setOrders] = useState<DishOrder[]>([])
  const [months, setMonths] = useState<string[]>([])
  const [month, setMonth] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!isDishGroupReady()) {
      setState('not-connected')
      setOrders([])
      setMonths([])
      return
    }
    setState('loading')
    setError('')
    try {
      const [list, ms] = await Promise.all([readOrders(month === 'all' ? undefined : month), listMonths()])
      setOrders(list)
      setMonths(ms)
      setState('data')
    } catch (e) {
      setError(errText(e))
      setState('not-connected')
    }
  }, [month])

  useEffect(() => {
    void load()
  }, [load, refreshTick])

  const onSyncReady = useCallback(() => {
    setRefreshTick((n) => n + 1)
  }, [])

  const reload = useCallback(() => setRefreshTick((n) => n + 1), [])

  const onDelete = useCallback(
    async (order: DishOrder) => {
      try {
        await deleteOrder(order)
        reload()
      } catch (e) {
        setError(`删除失败：${errText(e)}`)
      }
    },
    [reload],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orders
    return orders.filter((o) => {
      const hay = [o.date, o.meal, o.restaurant, o.note, ...o.items.map((it) => it.name)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [orders, query])

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6 space-y-4 text-white">
      <div>
        <h1 className="text-xl font-medium">点菜助手</h1>
        <p className="text-sm text-white/50 mt-1">导入点菜记录与价格，按月分片存到数据同步组；支持从照片经 AI Agent 生成后直接导入。</p>
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {/* 点菜记录置顶 */}
      <section className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap pt-2">
          <h2 className="font-medium">点菜记录</h2>
          <span className="text-xs text-white/40">{visible.length} 条</span>
          <div className="flex-1" />
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded bg-white/10 px-2.5 py-1.5 text-sm text-white/90 outline-none"
          >
            <option value="all">全部月份</option>
            {months.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索店名 / 菜名"
              className="rounded bg-white/10 pl-8 pr-3 py-1.5 text-sm text-white/90 placeholder-white/30 outline-none w-48"
            />
          </div>
          <button onClick={reload} title="刷新" className="rounded p-1.5 text-white/60 hover:bg-white/10">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {state === 'not-connected' ? (
          <div className="rounded-lg bg-white/5 p-8 text-center text-white/60">
            <p className="mb-2">尚未连接数据同步组</p>
            <p className="text-sm text-white/40">请在页面底部「数据同步组」面板中配置 dish-order 组的后端并连接，之后即可导入与查看记录。</p>
          </div>
        ) : state === 'loading' ? (
          <p className="text-sm text-white/50 py-8 text-center">加载中…</p>
        ) : visible.length === 0 ? (
          <div className="rounded-lg bg-white/5 p-8 text-center text-white/50">
            {orders.length === 0 ? '还没有点菜记录，先导入或手动新增一条吧。' : '没有匹配的记录。'}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((o) => (
              <OrderCard key={o.id} order={o} onDelete={() => void onDelete(o)} />
            ))}
          </div>
        )}
      </section>

      {state !== 'not-connected' && (
        <>
          <ImportPanel onImported={reload} disabled={false} />
          <ManualAddPanel onAdded={reload} disabled={false} />
        </>
      )}
      <PromptPanel />

      {/* 同步设置置底 */}
      <DishOrderSyncPanel onReady={onSyncReady} />
    </div>
  )
}
