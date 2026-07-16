import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BookmarkPlus, Tag, Globe, Loader2 } from 'lucide-react'
import { saveBookmarks } from '@/lib/pouchdb'
import { loadAppConfig } from '@/lib/config'
import { stringToColor } from '@/lib/bookmarks'
import type { AppConfig } from '@/types'

interface ShareDialogProps {
  url: string
  title: string
  open: boolean
  onClose: () => void
}

export default function ShareDialog({ url, title, open, onClose }: ShareDialogProps) {
  const [bookmarkTitle, setBookmarkTitle] = useState(title)
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (open) {
      setBookmarkTitle(title)
      setSaved(false)
      // 加载配置获取标签列表
      const config = loadAppConfig()
      if (config) {
        setAppConfig(config)
      }
    }
  }, [open, title])

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  const handleSave = async () => {
    if (!bookmarkTitle.trim()) return
    setSaving(true)
    try {
      const now = Date.now()
      const trimmedTitle = bookmarkTitle.trim()

      // 1. 保存到本地 PouchDB
      await saveBookmarks([
        {
          url,
          title: trimmedTitle,
          tags: selectedTags,
          description: '',
          icon: '',
          clicks: 0,
          createdAt: now,
          updatedAt: now,
        },
      ])

      // 2. onenav-temp 共享收件箱暂时停用：分享内容只保存到本地 PouchDB，
      // 后续由正常的 RemoteStorage 同步流程处理。

      setSaved(true)
      setTimeout(() => {
        onClose()
      }, 800)
    } catch (err) {
      console.error('[ShareDialog] 保存书签失败:', err)
      alert('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const domainColor = (() => {
    try {
      return stringToColor(new URL(url).hostname)
    } catch {
      return '#64748b'
    }
  })()

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-gray-900/95 backdrop-blur-xl border-white/10 text-white max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <BookmarkPlus className="w-5 h-5" />
            添加书签
          </DialogTitle>
          <DialogDescription className="text-white/50">
            从其他应用分享的内容
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* URL 预览 */}
          <div className="flex items-center gap-3 p-3 bg-white/5 rounded-lg">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: domainColor }}
            >
              <Globe className="w-5 h-5 text-white/80" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{bookmarkTitle || '未命名'}</p>
              <p className="text-xs text-white/40 truncate">{url}</p>
            </div>
          </div>

          {/* 标题编辑 */}
          <div className="space-y-1.5">
            <Label className="text-white/70 text-sm">标题</Label>
            <Input
              value={bookmarkTitle}
              onChange={(e) => setBookmarkTitle(e.target.value)}
              className="bg-white/5 border-white/20 text-white text-sm"
              placeholder="书签标题"
            />
          </div>

          {/* 标签选择 */}
          {appConfig && appConfig.tags.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-white/70 text-sm flex items-center gap-1">
                <Tag className="w-3.5 h-3.5" />
                标签
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {appConfig.tags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.tag)}
                    className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                      selectedTags.includes(tag.tag)
                        ? 'bg-white/25 text-white'
                        : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'
                    }`}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              onClick={onClose}
              className="flex-1 bg-white/5 border-white/20 text-white/70 hover:bg-white/10 hover:text-white"
            >
              取消
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !bookmarkTitle.trim() || saved}
              className="flex-1 bg-white/20 hover:bg-white/30 text-white"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saved ? (
                '已保存'
              ) : (
                '保存'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
