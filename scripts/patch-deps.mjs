/**
 * 构建期依赖补丁（幂等）。
 *
 * 这些修复尚未发版，但线上构建走 `npm ci` 只能拿到 registry 版本，
 * 所以在 build 前对 node_modules 做定点替换，保证构建产物与本地源码一致。
 *
 * 关键：同一个包同时存在 CJS(`dist/*.js`) 与 ESM(`dist/*.mjs`，可能被拆进 chunk)，
 * 而 vite 打包走的是 ESM。所以每条补丁按「目录下所有候选文件」逐一下手，
 * 命中哪个改哪个；一个都没命中就报错退出，避免补丁静默失效。
 *
 * 对应源码修复：
 *  - zen-fs-config  src/backend-registry.ts   readFile 兼容 'utf8' / { encoding }
 *  - zen-fs-sync    src/sync-pair.ts          lastError 带文件路径 + 干净轮次清除历史错误
 *  - zen-fs-gitee   src/gitee-api.ts          delete 400 复检按 200+[] 判不存在
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const nm = join(root, 'node_modules')

/** 列出某包 dist 下所有可能被打包的文件（js + mjs）。 */
function distFiles(pkg) {
  const dir = join(nm, pkg, 'dist')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .map((f) => join(dir, f))
}

const patches = [
  {
    name: 'zen-fs-config: readFile 兼容 utf8 编码串 / encoding 选项',
    files: distFiles('zen-fs-config'),
    from: `      if (args[0] === "utf-8") return new TextDecoder().decode(buf);`,
    to: `      const enc = typeof args[0] === "string" ? args[0] : args[0] && args[0].encoding;
      if (enc === "utf-8" || enc === "utf8" || enc === "UTF-8") return new TextDecoder().decode(buf);`,
  },
  {
    name: 'zen-fs-sync: lastError 带路径 + 干净轮次清除历史错误',
    files: distFiles('zen-fs-sync'),
    from: `        this.lastError = { message: result.errors[0].message, timestamp: result.timestamp };`,
    to: `        const e0 = result.errors[0];
        this.lastError = { message: (e0.path ? e0.path + ': ' : '') + e0.message, timestamp: result.timestamp };
      } else if (this.lastError) {
        this.lastError = void 0;`,
  },
  {
    name: 'zen-fs-gitee: delete 400 复检按 200+[] 判不存在',
    files: distFiles('zen-fs-gitee'),
    from: `            const stillExists = await this.request(\`/repos/\${this.owner}/\${this.repo}/contents/\${apiPath(path)}?ref=\${this.currentBranch}\`, undefined, { quiet404: true }).then(() => true).catch(() => false);\n            if (!stillExists)\n                return;`,
    to: `            const probe = await this.request(\`/repos/\${this.owner}/\${this.repo}/contents/\${apiPath(path)}?ref=\${this.currentBranch}\`, undefined, { quiet404: true }).catch(() => null);
            // Gitee 用 200 + [] 表示路径不存在；数组响应只能说明"是个目录"，都不算文件仍在。
            const stillExists = !!probe && !Array.isArray(probe);
            if (!stillExists)
                return;`,
  },
  {
    name: 'zen-fs-config-ui: 描述符在但会话内无实例时补载一次（修「已连接却显示未连接」）',
    files: distFiles('zen-fs-config-ui'),
    from: `    this.groupUnavailable = /* @__PURE__ */ new Map();
    for (const d of this.dataGroups) {
      if (!this.groupInstances.has(d.id)) {
        this.groupUnavailable.set(`,
    to: `    this.groupUnavailable = /* @__PURE__ */ new Map();
    for (const d of this.dataGroups) {
      if (!this.groupInstances.has(d.id)) {
        // 描述符已登记、但本次会话没有实例：多半是连接时配置组还没同步完（时序）。
        // 只对已有描述符补载一次，仍然失败才降级成「未连接」。
        try {
          const healed = await this.repo.getAppDataGroup(d.id);
          if (healed) {
            this.groupInstances.set(healed.groupId, healed);
            continue;
          }
        } catch (e) {
          /* 保持未连接 */
        }
        this.groupUnavailable.set(`,
  },
]

let failed = 0
for (const p of patches) {
  if (p.files.length === 0) {
    console.warn(`[patch-deps] skip (no dist files): ${p.name}`)
    continue
  }
  let appliedHere = 0
  let alreadyHere = 0
  for (const file of p.files) {
    let src
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (src.includes(p.to)) {
      alreadyHere++
      continue
    }
    if (!src.includes(p.from)) continue
    writeFileSync(file, src.replace(p.from, p.to), 'utf8')
    appliedHere++
  }
  const hit = appliedHere + alreadyHere
  if (hit === 0) {
    console.error(`[patch-deps] FAILED (anchor not found in any dist file): ${p.name}`)
    failed++
  } else {
    console.log(`[patch-deps] ok: ${p.name} (新打 ${appliedHere} 处 / 已是最新 ${alreadyHere} 处)`)
  }
}
if (failed > 0) process.exitCode = 1
console.log(`[patch-deps] done: ${patches.length - failed}/${patches.length}`)
