/**
 * OAuth 回调页面
 * 
 * 当 RemoteStorage OAuth 授权成功后，会重定向回这个页面。
 * 这个页面负责从 URL 中提取 token 并完成连接。
 */

import { useEffect, useState } from 'react'
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { connectWithToken } from '@/lib/remotestorage-connection'

export default function OAuthCallback() {
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing')
  const [error, setError] = useState('')

  useEffect(() => {
    const handleCallback = async () => {
      try {
        // 从 URL 中提取参数
        const hash = window.location.hash.substring(1) // 去掉 #
        const params = new URLSearchParams(hash)
        
        // 尝试获取 access_token 或 token
        let token = params.get('access_token') || params.get('token')
        let userAddress = params.get('username') || params.get('user')
        
        // 如果 URL 中有 state 参数，解析它获取 userAddress
        const state = params.get('state')
        if (state) {
          try {
            const stateObj = JSON.parse(atob(state))
            userAddress = stateObj.userAddress || userAddress
          } catch {
            // 忽略 state 解析错误
          }
        }

        if (!token) {
          // 尝试从 query string 获取
          const queryParams = new URLSearchParams(window.location.search)
          token = queryParams.get('access_token') || queryParams.get('token')
        }

        if (!token) {
          throw new Error('未找到 access_token')
        }

        console.log('[OAuth Callback] 获取到 token，准备连接...')

        // 连接 RemoteStorage
        // userAddress 如果没有提供，使用默认值
        const address = userAddress || 'anonymous@storage.5apps.com'
        
        connectWithToken(address, token)
        
        // 等待连接成功
        setTimeout(() => {
          setStatus('success')
          // 重定向回主页面
          setTimeout(() => {
            window.location.href = window.location.pathname
          }, 1500)
        }, 1000)
      } catch (err) {
        console.error('[OAuth Callback] 错误:', err)
        setError(err instanceof Error ? err.message : '未知错误')
        setStatus('error')
      }
    }

    handleCallback()
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900">
      <div className="text-center">
        {status === 'processing' && (
          <>
            <Loader2 className="w-12 h-12 text-white/60 animate-spin mx-auto mb-4" />
            <p className="text-white/60">正在处理授权...</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-4" />
            <p className="text-green-300">授权成功！正在跳转...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <p className="text-red-300 mb-2">授权失败</p>
            <p className="text-white/40 text-sm">{error}</p>
            <a
              href="/"
              className="mt-4 inline-block px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
            >
              返回首页
            </a>
          </>
        )}
      </div>
    </div>
  )
}
