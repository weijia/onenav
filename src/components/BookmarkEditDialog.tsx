import { useEffect, useState } from 'react'
import type { DisplayBookmark } from '@/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Trash2 } from 'lucide-react'

interface BookmarkEditDialogProps {
  open: boolean
  bookmark: DisplayBookmark | null
  onOpenChange: (open: boolean) => void
  onSave: (originalUrl: string, data: {
    title: string
    url: string
    tags: string[]
    description?: string
    icon?: string
  }) => Promise<void>
  onDelete: (url: string) => Promise<void>
}

export default function BookmarkEditDialog({ open, bookmark, onOpenChange, onSave, onDelete }: BookmarkEditDialogProps) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!bookmark) return
    setTitle(bookmark.title)
    setUrl(bookmark.url)
    setTagsText(bookmark.tags.join(', '))
    setDescription(bookmark.description || '')
    setIcon(bookmark.favicon || '')
    setError('')
    setConfirmDelete(false)
  }, [bookmark])

  const handleSave = async () => {
    if (!bookmark || saving || deleting) return
    const nextUrl = url.trim()
    if (!nextUrl) {
      setError('URL 不能为空')
      return
    }

    try {
      new URL(nextUrl)
    } catch {
      setError('请输入完整 URL，例如 https://example.com')
      return
    }

    setSaving(true)
    setError('')
    try {
      await onSave(bookmark.url, {
        title,
        url: nextUrl,
        tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
        description,
        icon,
      })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!bookmark || saving || deleting) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      setError('')
      return
    }

    setDeleting(true)
    setError('')
    try {
      await onDelete(bookmark.url)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-950 text-white border border-white/15 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑书签</DialogTitle>
          <DialogDescription className="text-white/50">
            修改后会保存到本地 PouchDB，并同步到 RemoteStorage。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-white/70">标题</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="bg-white/10 border-white/20 text-white" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-white/70">URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="bg-white/10 border-white/20 text-white" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-white/70">标签</Label>
            <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="用英文逗号分隔，例如 dev, docs" className="bg-white/10 border-white/20 text-white placeholder:text-white/30" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-white/70">描述</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-white/20 bg-white/10 px-2.5 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-white/70">图标 URL</Label>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} className="bg-white/10 border-white/20 text-white" />
          </div>

          {error && <p className="text-sm text-red-300">{error}</p>}
        </div>

        <DialogFooter className="bg-white/5 border-white/10 sm:justify-between">
          <Button
            variant="ghost"
            onClick={handleDelete}
            disabled={saving || deleting}
            className={confirmDelete ? 'text-red-200 hover:text-white hover:bg-red-500/20' : 'text-red-300/80 hover:text-red-100 hover:bg-red-500/15'}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {confirmDelete ? '确认删除' : '删除书签'}
          </Button>

          <div className="flex gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving || deleting} className="text-white/70 hover:text-white hover:bg-white/10">
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving || deleting}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            保存
          </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
