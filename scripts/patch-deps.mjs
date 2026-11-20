/**
 * 构建期依赖补丁（幂等）。
 *
 * 这三个依赖的修复尚未发版，但线上构建走 `npm ci` 只能拿到 registry 版本，
 * 所以在 build 前对 node_modules 做定点替换，保证构建产物与本地源码一致。
 * 每条补丁都带原文断言：替换不到就报错退出，避免静默失效。
 *
 * 对应源码修复：
 *  - zen-fs-config  src/backend-registry.ts        readFile 兼容 'utf8'
 *  - zen-fs-sync    src/sync-pair.ts               lastError 带文件路径
 *  - zen-fs-gitee   src/gitee-api.ts               delete 400 复检按 200+[] 判不存在
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const nm = join(root, 'node_modules')

const patches = [
  {
    name: 'zen-fs-config: readFile 兼容 utf8',
    file: join(nm, 'zen-fs-config/dist/index.js'),
    from: `      if (args[0] === "utf-8") return new TextDecoder().decode(buf);`,
    to: `      const enc = typeof args[0] === "string" ? args[0] : args[0] && args[0].encoding;
      if (enc === "utf-8" || enc === "utf8" || enc === "UTF-8") return new TextDecoder().decode(buf);`,
  },
  {
    name: 'zen-fs-sync: lastError 带文件路径',
    file: join(nm, 'zen-fs-sync/dist/index.js'),
    from: `        this.lastError = { message: result.errors[0].message, timestamp: result.timestamp };`,
    to: `        const e0 = result.errors[0];
        this.lastError = { message: (e0.path ? e0.path + ': ' : '') + e0.message, timestamp: result.timestamp };`,
  },
  {
    name: 'zen-fs-gitee: delete 400 复检按 200+[] 判不存在',
    file: join(nm, 'zen-fs-gitee/dist/gitee-api.js'),
    from: `            const stillExists = await this.request(\`/repos/\${this.owner}/\${this.repo}/contents/\${apiPath(path)}?ref=\${this.currentBranch}\`, undefined, { quiet404: true }).then(() => true).catch(() => false);\n            if (!stillExists)\n                return;`,
    to: `            const probe = await this.request(\`/repos/\${this.owner}/\${this.repo}/contents/\${apiPath(path)}?ref=\${this.currentBranch}\`, undefined, { quiet404: true }).catch(() => null);
            // Gitee 用 200 + [] 表示路径不存在；数组响应只能说明"是个目录"，都不算文件仍在。
            const stillExists = !!probe && !Array.isArray(probe);
            if (!stillExists)
                return;`,
  },
]

let applied = 0
for (const p of patches) {
  if (!existsSync(p.file)) {
    console.warn(`[patch-deps] skip (missing): ${p.name}`)
    continue
  }
  const src = readFileSync(p.file, 'utf8')
  if (src.includes(p.to)) {
    console.log(`[patch-deps] already applied: ${p.name}`)
    applied++
    continue
  }
  if (!src.includes(p.from)) {
    console.error(`[patch-deps] FAILED (anchor not found): ${p.name}`)
    process.exitCode = 1
    continue
  }
  writeFileSync(p.file, src.replace(p.from, p.to), 'utf8')
  console.log(`[patch-deps] applied: ${p.name}`)
  applied++
}
console.log(`[patch-deps] done: ${applied}/${patches.length}`)
