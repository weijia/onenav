import { useMemo, useState } from 'react'
import { Trash2, TrendingUp, TrendingDown, Wallet, Search, FileUp, FileDown, HelpCircle, ClipboardPaste } from 'lucide-react'
import { useAppData } from '@/lib/app-data'

interface Tx {
  id: string
  type: 'income' | 'expense'
  amount: number
  category: string
  note: string
  date: string // YYYY-MM-DD
  createdAt: number
  /** 数量（可选） */
  quantity?: number
  /** 单位，如 粒 / 斤 / 个 / 件（可选） */
  unit?: string
  /** 单价（可选） */
  unitPrice?: number
}

interface BookkeepingData {
  transactions: Tx[]
}

const CATEGORIES = ['餐饮', '交通', '购物', '居家', '娱乐', '医疗', '工资', '理财', '其他']
const UNIT_SUGGESTIONS = ['粒', '斤', '个', '件', '克', '包', '瓶', '盒', '份', '条', '袋', '次']

function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function randId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeType(v: unknown): 'income' | 'expense' {
  const s = String(v ?? '').trim()
  if (s === 'income' || s === '收入' || s === 'in' || s === '+') return 'income'
  return 'expense'
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 把任意（可能由其他 AI 生成的）JSON 行归一化为合法 Tx；无法解析返回 null */
function normalizeRow(raw: unknown, fallbackDate: string): Tx | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = normalizeType(r.type)
  let amount = toNumber(r.amount)
  const quantity = toNumber(r.quantity)
  const unitPrice = toNumber(r.unitPrice)
  if (!amount && quantity && unitPrice) {
    amount = Math.round(quantity * unitPrice * 100) / 100
  }
  if (!amount) return null // 没有金额也无法推算的行跳过
  const date = typeof r.date === 'string' && DATE_RE.test(r.date) ? r.date : fallbackDate
  const category = typeof r.category === 'string' && r.category.trim() ? r.category.trim() : '其他'
  const note = typeof r.note === 'string' ? r.note.trim() : ''
  const unit = typeof r.unit === 'string' ? r.unit.trim() : ''
  return {
    id: randId(),
    type,
    amount,
    category,
    note,
    date,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    quantity: quantity || undefined,
    unit: unit || undefined,
    unitPrice: unitPrice || undefined,
  }
}

/** 导出用的标准形状（供其他 AI 照此生成/导入） */
function toExportShape(t: Tx) {
  return {
    date: t.date,
    type: t.type,
    category: t.category,
    amount: t.amount,
    note: t.note,
    quantity: t.quantity ?? null,
    unit: t.unit ?? null,
    unitPrice: t.unitPrice ?? null,
  }
}

/** 解析导入文本（文件内容或粘贴内容通用）：支持数组 或 { transactions: [...] }，返回有效行与跳过行数 */
function parseImportText(text: string): { valid: Tx[]; skipped: number } {
  const parsed = JSON.parse(text)
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.transactions)
      ? parsed.transactions
      : null
  if (!arr) throw new Error('JSON 应为数组，或 { "transactions": [...] }')
  const valid: Tx[] = []
  let skipped = 0
  const fd = today()
  for (const raw of arr) {
    const row = normalizeRow(raw, fd)
    if (row) valid.push(row)
    else skipped++
  }
  if (valid.length === 0) throw new Error('没有可导入的有效记录')
  return { valid, skipped }
}

const FORMAT_HELP = `标准 JSON 格式（数组，或 { "transactions": [...] }）：

[
  {
    "date": "2026-10-01",
    "type": "expense",        // expense=支出 / income=收入（中文“支出”“收入”也可）
    "category": "餐饮",
    "amount": 12.5,           // 金额；若只给 quantity+unitPrice 会自动算
    "note": "午餐",
    "quantity": 1,            // 可选
    "unit": "份",             // 可选：粒 / 斤 / 个 / 件 …
    "unitPrice": 12.5         // 可选：单价
  }
]

- 字段均可省略；type 与 date 容错，无法解析的行会被跳过并计数。
- 导出的文件即为此格式，可直接当模板交给其他 AI 生成。`

/** 记账小应用：收支记录的增删、单价记录、搜索、JSON 导入导出，数据随同步层跨设备同步 */
export default function BookkeepingApp() {
  const { data, loading, save } = useAppData<BookkeepingData>('bookkeeping', { transactions: [] })
  const [type, setType] = useState<'income' | 'expense'>('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('餐饮')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today())

  // 单价 / 数量 / 单位（可选）
  const [showUnit, setShowUnit] = useState(false)
  const [unitPrice, setUnitPrice] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')

  // 搜索与筛选
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'expense' | 'income'>('all')

  // 导入预览
  const [importPreview, setImportPreview] = useState<{ valid: Tx[]; skipped: number } | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [importError, setImportError] = useState<string | null>(null)
  const [showFormatHelp, setShowFormatHelp] = useState(false)
  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')

  const transactions = useMemo(() => data?.transactions || [], [data])

  const { income, expense, balance } = useMemo(() => {
    let inc = 0
    let exp = 0
    for (const t of transactions) {
      if (t.type === 'income') inc += t.amount
      else exp += t.amount
    }
    return { income: inc, expense: exp, balance: inc - exp }
  }, [transactions])

  const sorted = useMemo(
    () =>
      [...transactions].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1
        return b.createdAt - a.createdAt
      }),
    [transactions]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sorted.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false
      if (!q) return true
      const hay = [
        t.note,
        t.category,
        t.unit,
        String(t.amount),
        t.unitPrice != null ? String(t.unitPrice) : '',
        t.quantity != null ? String(t.quantity) : '',
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [sorted, search, typeFilter])

  // 单价×数量自动算金额
  const computedAmount = useMemo(() => {
    const q = toNumber(quantity)
    const p = toNumber(unitPrice)
    if (q && p) return Math.round(q * p * 100) / 100
    return 0
  }, [quantity, unitPrice])

  const handleAdd = async () => {
    const amt = computedAmount || Number(amount)
    if (!amt || amt <= 0) return
    const tx: Tx = {
      id: randId(),
      type,
      amount: amt,
      category: category || '其他',
      note: note.trim(),
      date,
      createdAt: Date.now(),
      quantity: toNumber(quantity) || undefined,
      unit: unit.trim() || undefined,
      unitPrice: toNumber(unitPrice) || undefined,
    }
    await save({ transactions: [tx, ...transactions] })
    setAmount('')
    setNote('')
    setQuantity('')
    setUnitPrice('')
    setUnit('')
    setShowUnit(false)
  }

  const handleDelete = async (id: string) => {
    await save({ transactions: transactions.filter((t) => t.id !== id) })
  }

  const handleExport = () => {
    const payload = transactions.map(toExportShape)
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bookkeeping-${today()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    setImportError(null)
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        setImportPreview(parseImportText(String(reader.result)))
      } catch (err) {
        setImportError(err instanceof Error ? err.message : '解析失败')
      } finally {
        e.target.value = ''
      }
    }
    reader.readAsText(file)
  }

  const handlePasteImport = () => {
    setImportError(null)
    try {
      setImportPreview(parseImportText(pasteText))
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '解析失败')
    }
  }

  const confirmImport = async () => {
    if (!importPreview) return
    const next =
      importMode === 'replace' ? importPreview.valid : [...importPreview.valid, ...transactions]
    await save({ transactions: next })
    setImportPreview(null)
  }

  if (loading) {
    return <div className="text-center text-white/40 py-10">加载中…</div>
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-5 space-y-5">
      {/* 汇总 */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="收入" value={income} accent="text-emerald-300" icon={<TrendingUp className="w-4 h-4" />} />
        <SummaryCard label="支出" value={expense} accent="text-rose-300" icon={<TrendingDown className="w-4 h-4" />} />
        <SummaryCard label="结余" value={balance} accent="text-white" icon={<Wallet className="w-4 h-4" />} />
      </div>

      {/* 添加记录 */}
      <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => setType('expense')}
            className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
              type === 'expense'
                ? 'bg-rose-500/20 text-rose-200 border border-rose-400/30'
                : 'bg-white/5 text-white/50 border border-white/10'
            }`}
          >
            支出
          </button>
          <button
            onClick={() => setType('income')}
            className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
              type === 'income'
                ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30'
                : 'bg-white/5 text-white/50 border border-white/10'
            }`}
          >
            收入
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-2 outline-none focus:border-white/40 [color-scheme:dark]"
          />
          <input
            type="number"
            inputMode="decimal"
            placeholder={computedAmount ? `金额（已算 ${computedAmount}）` : '金额'}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="flex-1 h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                category === c ? 'bg-white/25 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* 单价 / 数量（可选） */}
        <button
          onClick={() => setShowUnit((v) => !v)}
          className="text-xs text-white/45 hover:text-white/70 flex items-center gap-1"
        >
          {showUnit ? '▾' : '▸'} 单价 / 数量（可选，如按粒、按斤）
        </button>
        {showUnit && (
          <div className="grid grid-cols-3 gap-2">
            <input
              type="number"
              inputMode="decimal"
              placeholder="单价"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
            />
            <input
              type="number"
              inputMode="decimal"
              placeholder="数量"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
            />
            <input
              list="unit-suggestions"
              placeholder="单位"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
            />
            <datalist id="unit-suggestions">
              {UNIT_SUGGESTIONS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>
        )}

        <div className="flex gap-2">
          <input
            placeholder="备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="flex-1 h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
          />
          <button
            onClick={handleAdd}
            disabled={!(computedAmount || (amount && Number(amount) > 0))}
            className="px-4 h-9 rounded-lg bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm disabled:opacity-40"
          >
            添加
          </button>
        </div>
      </div>

      {/* 搜索 / 筛选 / 导入导出 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
          <input
            type="text"
            placeholder="搜索备注 / 分类 / 单位 / 金额…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 pl-10 pr-3 rounded-lg bg-white/10 border border-white/20 text-white text-sm outline-none focus:border-white/40"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'expense', 'income'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                typeFilter === f ? 'bg-white/25 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              {f === 'all' ? '全部' : f === 'expense' ? '支出' : '收入'}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <label className="px-2.5 py-1.5 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10 cursor-pointer flex items-center gap-1">
            <FileUp className="w-3.5 h-3.5" /> 导入
            <input
              type="file"
              accept=".json,application/json,.txt"
              className="hidden"
              onChange={handleImportFile}
            />
          </label>
          <button
            onClick={() => setShowPaste((v) => !v)}
            className={`px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 ${
              showPaste ? 'bg-white/25 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            <ClipboardPaste className="w-3.5 h-3.5" /> 粘贴
          </button>
          <button
            onClick={handleExport}
            className="px-2.5 py-1.5 rounded-lg text-xs bg-white/5 text-white/60 hover:bg-white/10 flex items-center gap-1"
          >
            <FileDown className="w-3.5 h-3.5" /> 导出
          </button>
          <button
            onClick={() => setShowFormatHelp((v) => !v)}
            className="w-8 h-8 rounded-lg text-xs bg-white/5 text-white/50 hover:bg-white/10 flex items-center justify-center"
            title="导入格式说明"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showPaste && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-2">
          <p className="text-xs text-white/50">把其他 AI 生成的 JSON 直接粘贴到这里，点「解析并预览」即可导入：</p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'[\n  { "date": "2026-10-01", "type": "expense", "category": "餐饮", "amount": 12.5, "note": "午餐", "quantity": 1, "unit": "份", "unitPrice": 12.5 }\n]'}
            className="w-full h-32 rounded-lg bg-black/30 border border-white/15 text-white text-xs px-3 py-2 outline-none focus:border-white/40 font-mono resize-y"
          />
          <div className="flex gap-2">
            <button
              onClick={handlePasteImport}
              disabled={!pasteText.trim()}
              className="px-3 py-1.5 rounded-lg text-xs bg-emerald-500/80 hover:bg-emerald-500 text-white disabled:opacity-40"
            >
              解析并预览
            </button>
            <button
              onClick={() => setShowPaste(false)}
              className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/60 border border-white/10"
            >
              收起
            </button>
          </div>
        </div>
      )}

      {showFormatHelp && (
        <pre className="rounded-xl bg-black/30 border border-white/10 p-3 text-[11px] leading-relaxed text-white/70 whitespace-pre-wrap">
          {FORMAT_HELP}
        </pre>
      )}

      {importError && (
        <div className="rounded-lg bg-red-500/15 border border-red-400/30 text-red-200 text-sm px-3 py-2">
          {importError}
        </div>
      )}

      {/* 记录列表 */}
      <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5">
        {filtered.length === 0 && (
          <p className="text-center text-white/40 py-8 text-sm">
            {transactions.length === 0 ? '还没有记录，添加第一笔吧' : '没有匹配的记录'}
          </p>
        )}
        {filtered.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="text-white/90 text-sm truncate">
                {t.category}
                {t.note ? ` · ${t.note}` : ''}
                {t.unitPrice ? ` · ¥${t.unitPrice}/${t.unit ?? ''}${t.quantity ? ` ×${t.quantity}` : ''}` : ''}
              </div>
              <div className="text-white/40 text-xs">{t.date}</div>
            </div>
            <div className={`text-sm font-medium ${t.type === 'income' ? 'text-emerald-300' : 'text-rose-300'}`}>
              {t.type === 'income' ? '+' : '-'}
              {t.amount.toFixed(2)}
            </div>
            <button
              onClick={() => handleDelete(t.id)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              title="删除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* 导入预览弹窗 */}
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setImportPreview(null)}>
          <div
            className="w-full max-w-sm rounded-xl bg-zinc-900 border border-white/15 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-white font-medium">导入预览</h3>
            <p className="text-sm text-white/70">
              识别到 <span className="text-emerald-300 font-medium">{importPreview.valid.length}</span> 条有效记录
              {importPreview.skipped > 0 && (
                <span className="text-rose-300">，{importPreview.skipped} 条已跳过（缺金额或无法解析）</span>
              )}
              。
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setImportMode('merge')}
                className={`flex-1 py-2 rounded-lg text-sm ${
                  importMode === 'merge'
                    ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                合并到现有
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={`flex-1 py-2 rounded-lg text-sm ${
                  importMode === 'replace'
                    ? 'bg-rose-500/25 text-rose-200 border border-rose-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10'
                }`}
              >
                替换全部
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setImportPreview(null)}
                className="flex-1 py-2 rounded-lg text-sm bg-white/5 text-white/60 border border-white/10"
              >
                取消
              </button>
              <button
                onClick={confirmImport}
                className="flex-1 py-2 rounded-lg text-sm bg-emerald-500/80 hover:bg-emerald-500 text-white"
              >
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  accent,
  icon,
}: {
  label: string
  value: number
  accent: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-3">
      <div className="flex items-center gap-1 text-white/40 text-xs mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-lg font-semibold ${accent}`}>{value.toFixed(2)}</div>
    </div>
  )
}
