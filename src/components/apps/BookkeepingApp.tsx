import { useMemo, useState } from 'react'
import { Trash2, TrendingUp, TrendingDown, Wallet } from 'lucide-react'
import { useAppData } from '@/lib/app-data'

interface Tx {
  id: string
  type: 'income' | 'expense'
  amount: number
  category: string
  note: string
  date: string // YYYY-MM-DD
  createdAt: number
}

interface BookkeepingData {
  transactions: Tx[]
}

const CATEGORIES = ['餐饮', '交通', '购物', '居家', '娱乐', '医疗', '工资', '理财', '其他']

function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 记账小应用：收支记录的增删与汇总，数据通过 useAppData 随同步层跨设备同步 */
export default function BookkeepingApp() {
  const { data, loading, save } = useAppData<BookkeepingData>('bookkeeping', { transactions: [] })
  const [type, setType] = useState<'income' | 'expense'>('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('餐饮')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today())

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

  const handleAdd = async () => {
    const amt = Number(amount)
    if (!amt || amt <= 0) return
    const tx: Tx = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      amount: amt,
      category: category || '其他',
      note: note.trim(),
      date,
      createdAt: Date.now(),
    }
    await save({ transactions: [tx, ...transactions] })
    setAmount('')
    setNote('')
  }

  const handleDelete = async (id: string) => {
    await save({ transactions: transactions.filter((t) => t.id !== id) })
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
            placeholder="金额"
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

        <div className="flex gap-2">
          <input
            placeholder="备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="flex-1 h-9 rounded-lg bg-white/10 border border-white/20 text-white text-sm px-3 outline-none focus:border-white/40"
          />
          <button
            onClick={handleAdd}
            disabled={!amount || Number(amount) <= 0}
            className="px-4 h-9 rounded-lg bg-emerald-500/80 hover:bg-emerald-500 text-white text-sm disabled:opacity-40"
          >
            添加
          </button>
        </div>
      </div>

      {/* 记录列表 */}
      <div className="rounded-xl bg-white/5 border border-white/10 divide-y divide-white/5">
        {sorted.length === 0 && (
          <p className="text-center text-white/40 py-8 text-sm">还没有记录，添加第一笔吧</p>
        )}
        {sorted.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="text-white/90 text-sm truncate">
                {t.category}
                {t.note ? ` · ${t.note}` : ''}
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
