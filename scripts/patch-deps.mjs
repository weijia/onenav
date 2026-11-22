/**
 * 构建期依赖补丁（幂等）。
 *
 * 只为「源码已修好、但 registry 版本还没修」的点打补丁：线上构建走 `npm ci`
 * 只能拿到 registry 版本，所以 build 前对 node_modules 做定点替换，保证构建产物与本地源码一致。
 *
 * 关键：同一个包同时存在 CJS(`dist/*.js`) 与 ESM(`dist/*.mjs`，可能被拆进 chunk)，
 * 而 vite 打包走的是 ESM。所以每条补丁按「目录下所有候选文件」逐一下手，
 * 命中哪个改哪个；一个都没命中就报错退出，避免补丁静默失效。
 *
 * 当前没有任何补丁：最后一条（zen-fs-gitee delete 400 复检按 200+[] 判不存在）
 * 已随 zen-fs-gitee 1.2.43 发布，必须删掉，否则会对着已修好的代码重复注入。
 * 历史上其它三条也已随发版落地：
 *  - zen-fs-config readFile 兼容 'utf8' / { encoding }  → 0.8.0 起随包发布
 *  - zen-fs-sync   lastError 带路径 + 干净轮次清除历史错误 → 0.4.18 起随包发布
 *  - zen-fs-config-ui 描述符已登记但会话无实例时补载一次  → 0.4.0 起随包发布
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

const patches = []

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
