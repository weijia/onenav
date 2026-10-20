import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import fs from 'fs'

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

// 自动发现 apps/<id>/index.html 作为多页面入口（MPA）。
// 每个内置小应用都是独立的 HTML 文件，主页面打开时不会加载这些应用的代码，
// 只有访问对应页面（apps/<id>/index.html）时才下载其自身的 chunk。
const appEntries: Record<string, string> = {}
const appsDir = path.resolve(__dirname, 'apps')
if (fs.existsSync(appsDir)) {
  for (const name of fs.readdirSync(appsDir)) {
    const htmlPath = path.resolve(appsDir, name, 'index.html')
    if (fs.existsSync(htmlPath)) appEntries[`app-${name}`] = htmlPath
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
      injectRegister: false,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
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
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        ...appEntries,
      },
    },
  },
})
