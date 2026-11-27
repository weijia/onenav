// 标签相关的展示组件：清单自带标签（indigo）、用户标签（琥珀）、编辑弹窗。
// 目录视图 / 磁盘视图 / UFS 视图共用，避免各自复制一份导致交互与配色不一致。

import { useEffect, useState } from 'react'

/** 清单自带标签（indigo）；active 表示正被当作筛选条件 */
export function TagChip({
  tag,
  active,
  onClick,
}: {
  tag: string
  active?: boolean
  onClick?: () => void
}) {
  const cls = `px-1.5 py-0.5 rounded text-[10px] font-mono leading-none ${
    active
      ? 'bg-indigo-500/35 text-indigo-100 ring-1 ring-indigo-300/50'
      : 'bg-indigo-500/15 text-indigo-200/90'
  }`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={(e) => { e.stopPropagation(); onClick() }}>
        {tag}
      </button>
    )
  }
  return <span className={cls}>{tag}</span>
}

/** 用户自定义标签（琥珀）；点击切换标签筛选 */
export function UserTagChip({
  tag,
  active,
  onClick,
}: {
  tag: string
  active?: boolean
  onClick?: () => void
}) {
  const cls = `px-1.5 py-0.5 rounded text-[10px] font-mono leading-none ${
    active
      ? 'bg-amber-500/35 text-amber-100 ring-1 ring-amber-300/50'
      : 'bg-amber-500/15 text-amber-200/90 ring-1 ring-amber-400/20'
  }`
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={(e) => { e.stopPropagation(); onClick() }}>
        {tag}
      </button>
    )
  }
  return <span className={cls}>{tag}</span>
}

/**
 * 标签编辑弹窗：当前标签以可删除芯片展示；输入框回车/逗号加标签；建议整棵树已有标签。
 * pathLabel 仅用于展示（UFS 快照根 path 为空串时显示「（快照根）」）。
 */
export function TagEditorModal({
  editor,
  allTags,
  onClose,
  onSave,
  pathLabel,
}: {
  editor: { key: string; path: string; current: string[] } | null
  allTags: string[]
  onClose: () => void
  onSave: (tags: string[]) => void
  pathLabel?: string
}) {
  const [draft, setDraft] = useState<string[]>(editor?.current ?? [])
  const [input, setInput] = useState('')

  useEffect(() => {
    setDraft(editor?.current ?? [])
    setInput('')
  }, [editor])

  if (!editor) return null

  const addTag = (raw: string) => {
    const t = raw.trim()
    if (!t || draft.includes(t)) {
      setInput('')
      return
    }
    setDraft((d) => [...d, t])
    setInput('')
  }
  const removeTag = (t: string) => setDraft((d) => d.filter((x) => x !== t))
  const suggestions = allTags.filter((t) => !draft.includes(t))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-[min(92vw,420px)] rounded-xl bg-[#1b1f27] border border-white/10 p-4 space-y-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white/90 font-medium text-sm">编辑标签</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-white/40 hover:text-white text-sm leading-none"
          >
            ✕
          </button>
        </div>
        <div className="text-white/40 text-xs font-mono break-all">
          路径：{pathLabel ?? editor.path}
        </div>

        <div className="flex flex-wrap gap-1.5 min-h-[24px]">
          {draft.length === 0 && <span className="text-white/30 text-xs">暂无标签</span>}
          {draft.map((t) => (
            <span
              key={t}
              className="px-1.5 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/20 flex items-center gap-1"
            >
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                className="text-amber-200/70 hover:text-white leading-none"
              >
                ✕
              </button>
            </span>
          ))}
        </div>

        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addTag(input)
            } else if (e.key === 'Backspace' && !input && draft.length) {
              removeTag(draft[draft.length - 1])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
          placeholder="输入标签后回车或逗号添加…"
          className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/85 text-sm outline-none focus:border-white/25"
        />

        {suggestions.length > 0 && (
          <div>
            <div className="text-white/35 text-xs mb-1">建议（已有标签）</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => addTag(t)}
                  className="px-1.5 py-0.5 rounded text-[11px] bg-white/5 text-white/60 hover:bg-white/15 hover:text-white"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-white/5 text-white/70 hover:bg-white/15 text-sm"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="px-3 py-1.5 rounded-lg bg-amber-500/80 hover:bg-amber-500 text-white text-sm"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
