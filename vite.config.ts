import { defineConfig, type Plugin } from 'vite'
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

/**
 * 把构建时的版本清单原样输出到 dist/version.json。
 *
 * 页面里的「强制检查更新」按钮会在运行时 `fetch('<站点根>/version.json', {cache:'no-store'})`，
 * 与编译进本包的版本（sha/buildTime）比对，因此该文件必须：
 *  1. 位于站点根目录（主页 /apps/<id>/ 页面都能取到）；
 *  2. **不进入 SW 预缓存**（见下方 globIgnores），否则 no-store 也会被 Workbox 拦截成旧内容。
 *
 * 内容来自 scripts/generate-version.js 在 build 前生成的 src/version.json。
 */
function emitVersionManifest(): Plugin {
  return {
    name: 'emit-version-manifest',
    apply: 'build',
    generateBundle() {
      const src = path.resolve(__dirname, 'src/version.json')
      if (!fs.existsSync(src)) return
      this.emitFile({ type: 'asset', fileName: 'version.json', source: fs.readFileSync(src, 'utf8') })
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
    emitVersionManifest(),
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
        // version.json 是「检查更新」的探针文件，必须每次走网络，不能被预缓存覆盖
        globIgnores: ['version.json'],
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
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // pouchdb-browser 的 ESM 构建里写着 `import EE from 'events'`（Node 内置模块）。
      // Vite 会把它换成 `__vite-browser-external` 的空对象，于是
      // `class Changes extends EE` 在模块求值时就抛
      // 「Class extends value #<Object> is not a constructor or null」，
      // 整个 pouchdb 动态导入失败（golf 页的数据同步组因此连不上）。
      // 指到 npm 的 events polyfill，让 EE 是一个真的构造器。
      { find: /^events$/, replacement: path.resolve(__dirname, './node_modules/events/events.js') },
    ],
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
