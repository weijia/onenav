import { useState, useEffect } from 'react'
import MainPage from '@/components/MainPage'
import UpdateToast from '@/components/UpdateToast'
import ShareDialog from '@/components/ShareDialog'

/** 从 URL 参数解析分享内容 */
function parseShareParams(): { url: string; title: string } | null {
  const params = new URLSearchParams(window.location.search)
  const rawUrl = params.get('url')
  const rawText = params.get('text')
  const rawTitle = params.get('title')

  // 提取 URL：优先用 url 参数，否则从 text 中提取
  let url = rawUrl || ''
  if (!url && rawText) {
    // text 中可能包含 URL，尝试提取
    const urlMatch = rawText.match(/https?:\/\/[^\s]+/)
    if (urlMatch) url = urlMatch[0]
  }
  if (!url) return null

  // 提取标题：优先用 title 参数，否则用 text（去掉 URL 后的部分）
  let title = rawTitle || ''
  if (!title && rawText) {
    title = rawText.replace(/https?:\/\/[^\s]+/, '').trim()
  }
  if (!title) {
    // 从 URL 中提取域名作为默认标题
    try {
      title = new URL(url).hostname
    } catch {
      title = '新书签'
    }
  }

  return { url, title }
}

export default function App() {
  const [shareData, setShareData] = useState<{ url: string; title: string } | null>(null)

  useEffect(() => {
    // 检测 Web Share Target 分享参数
    const share = parseShareParams()
    if (share) {
      console.log('[App] 检测到分享内容:', share)
      setShareData(share)
    }
  }, [])

  // 未配置 WebDAV / RemoteStorage 也不再拦截主页：应用以本地模式运行
  // （书签与设置存在本机 PouchDB / localStorage），并在主页提示用户去设置里配置同步。
  return (
    <>
      <MainPage />
      <UpdateToast />
      <ShareDialog
        url={shareData?.url || ''}
        title={shareData?.title || ''}
        open={!!shareData}
        onClose={() => {
          setShareData(null)
          // 清理 URL 参数，避免刷新时再次弹出
          if (window.history.replaceState) {
            window.history.replaceState({}, document.title, window.location.pathname)
          }
        }}
      />
    </>
  )
}
