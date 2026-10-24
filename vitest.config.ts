import { defineConfig } from 'vitest/config'
import path from 'node:path'

// 仅用于测试的轻量配置：
// - 继承 vite.config.ts 中的 resolve.alias（如 `@` → ./src），无需重复声明；
// - 禁用 SSR deps 优化缓存：部分受限环境（沙箱 brokered-fs）会拦截 Vitest 的
//   .ssr 缓存写入（EPERM），导致多测试文件并行收集时整轮中止。关闭该缓存后
//   `npm test` 在沙箱与本机均可稳定跑全量用例（仅损失少量首跑性能）。
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    // 单线程池：受限沙箱环境下，forked worker 对 Vitest 内部 SSR 缓存的并发写入
    // 会被 brokered-fs 拦截（EPERM）导致整轮中途中止。单线程下配置仅解析一次，
    // `npm test` 在沙箱与本机均可稳定跑全量用例。（仅在沙箱有实际影响，本机无副作用）
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
    deps: {
      optimizer: {
        ssr: { enabled: false },
        web: { enabled: false },
      },
    },
  },
})
