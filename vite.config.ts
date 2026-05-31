import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import pkg from './package.json'

// 获取东八区时间字符串
function getChinaTime() {
  const now = new Date()
  // UTC+8
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return chinaTime.toISOString().replace('Z', '+08:00')
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(getChinaTime()),
    '__APP_VERSION__': JSON.stringify(pkg.version),
  },
})
