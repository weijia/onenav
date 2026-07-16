import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import pkg from './package.json'

// 获取东八区时间字符串
function getChinaTime() {
  const now = new Date()
  // UTC+8
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return chinaTime.toISOString().replace('Z', '+08:00')
}

function silenceUniversalSyncDebug() {
  return {
    name: 'silence-universal-sync-debug',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.includes('universal-sync-v2')) return null
      return code.replace(
        /typeof process !== ['"]undefined['"] \? process\.env\.DEBUG === ['"]true['"] : true/g,
        "typeof process !== 'undefined' ? process.env.DEBUG === 'true' : false",
      )
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    silenceUniversalSyncDebug(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      manifest: {
        name: 'OneNav',
        short_name: 'OneNav',
        description: '浏览器首页 - 书签导航',
        theme_color: '#1e3a8a',
        background_color: '#1e3a8a',
        display: 'standalone',
        orientation: 'portrait',
        scope: './',
        start_url: './',
        share_target: {
          action: './',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
        icons: [
          {
            src: 'icon-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    '__APP_BUILD_TIME__': JSON.stringify(getChinaTime()),
    '__APP_VERSION__': JSON.stringify(pkg.version),
  },
})
