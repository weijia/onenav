import { useState } from 'react'
import type { WebDAVConfig } from '@/types'
import { saveWebDAVConfig } from '@/lib/config'
import { getFileContents } from '@/lib/webdav'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Globe, Loader2, Eye, EyeOff } from 'lucide-react'

interface SetupPageProps {
  onConfigured: () => void
}

export default function SetupPage({ onConfigured }: SetupPageProps) {
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleConnect = async () => {
    if (!url || !username || !password) {
      setError('Please fill in all fields')
      return
    }

    setLoading(true)
    setError('')

    const config: WebDAVConfig = {
      url: url.replace(/\/+$/, ''),
      username,
      password,
    }

    try {
      // Test connection by trying to fetch the shared config file
      await getFileContents(config, 'config/webdav_config.json')
      saveWebDAVConfig(config)
      onConfigured()
    } catch (err) {
      setError(`Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900 p-4">
      <div className="w-full max-w-md bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-8 animate-slide-in">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
            <Globe className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">OneNav Setup</h1>
            <p className="text-sm text-white/60">Configure your WebDAV connection</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-white/80">WebDAV URL</Label>
            <Input
              type="url"
              placeholder="https://your-webdav-server.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus-visible:border-white/40 focus-visible:ring-white/20"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-white/80">Username</Label>
            <Input
              type="text"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus-visible:border-white/40 focus-visible:ring-white/20"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-white/80">Password</Label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                className="bg-white/10 border-white/20 text-white placeholder:text-white/40 focus-visible:border-white/40 focus-visible:ring-white/20 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <Button
            onClick={handleConnect}
            disabled={loading}
            className="w-full bg-white/20 hover:bg-white/30 text-white border border-white/20 h-10"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect & Test'
            )}
          </Button>
        </div>

        <p className="mt-6 text-xs text-white/40 text-center">
          Your credentials are stored locally in the browser.
        </p>
      </div>
    </div>
  )
}
