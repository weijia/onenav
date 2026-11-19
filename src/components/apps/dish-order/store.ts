/**
 * 点菜助手存储层：数据组持有 + 按月分片的记录读写。
 *
 * 数据布局（相对 dish-order 数据组逻辑根）：
 *   /orders/YYYY/MM/<id>.json   一条记录一个文件，按月分片避免单目录文件过多。
 *
 * 复用 fs-config-backends 注册/解析数据组，group.fs.promises 直接读写，
 * group.flush() 拉远端、group.deleteFile() 写墓碑（防同步复活）。
 */
import type { AppDataGroup } from 'zen-fs-config'
import type { DishOrder } from './format'
import { ORDERS_DIR, orderFilePath, sanitizeKey } from './format'

let activeGroup: AppDataGroup | null = null

export class DishStoreNotConnectedError extends Error {
  code = 'NOT_CONNECTED'
  constructor(message = '未连接点菜助手数据同步组') {
    super(message)
    this.name = 'DishStoreNotConnectedError'
  }
}

interface GroupPromisesFs {
  readFile(path: string, encoding?: string): Promise<any>
  writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: any): Promise<any>
  stat(path: string): Promise<any>
  unlink(path: string): Promise<void>
}

export function attachDishGroup(group: AppDataGroup | null): void {
  activeGroup = group
}

export function detachDishGroup(): void {
  activeGroup = null
}

export function isDishGroupReady(): boolean {
  return activeGroup !== null && !!activeGroup.fs?.promises
}

function getFs(): GroupPromisesFs {
  const p = (activeGroup as any)?.fs?.promises as GroupPromisesFs | undefined
  if (!p) throw new DishStoreNotConnectedError()
  return p
}

function getGroup(): AppDataGroup {
  if (!activeGroup) throw new DishStoreNotConnectedError()
  return activeGroup
}

/** 拉远端一次（最佳努力）；未就绪时忽略 */
export async function flushDishGroup(): Promise<void> {
  try {
    if (activeGroup && typeof activeGroup.flush === 'function') await activeGroup.flush()
  } catch (e) {
    console.warn('[dish-order] 同步组刷新失败:', e)
  }
}

/** 逐级建目录，忽略 EEXIST（部分后端 mkdir 不认 recursive） */
async function ensureDir(fs: GroupPromisesFs, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let cur = ''
  for (const part of parts) {
    cur += `/${part}`
    try {
      await fs.mkdir(cur)
    } catch (e: any) {
      if (e?.code !== 'EEXIST' && !/exist/i.test(String(e?.message ?? e))) throw e
    }
  }
}

function normalizeNames(entries: unknown[]): string[] {
  return entries
    .map((e) => (typeof e === 'string' ? e : String((e as any)?.name ?? e)))
    .map((s) => s.replace(/^\.\//, ''))
}

/** 列出已有月份（YYYY-MM），倒序；目录不存在或无数据返回空 */
export async function listMonths(): Promise<string[]> {
  const fs = getFs()
  const years = normalizeNames(await fs.readdir(ORDERS_DIR).catch(() => [] as string[]))
  const out: string[] = []
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue
    const months = normalizeNames(await fs.readdir(`${ORDERS_DIR}/${y}`).catch(() => [] as string[]))
    for (const m of months) {
      if (/^\d{2}$/.test(m)) out.push(`${y}-${m}`)
    }
  }
  return out.sort((a, b) => b.localeCompare(a))
}

/**
 * 读取指定月份（YYYY-MM）的记录；未指定则读全部月份。
 * 单文件解析失败跳过，不阻断其余记录。
 */
export async function readOrders(month?: string): Promise<DishOrder[]> {
  const fs = getFs()
  await flushDishGroup()

  let dirs: string[]
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    dirs = [`${ORDERS_DIR}/${month.slice(0, 4)}/${month.slice(5)}`]
  } else {
    const months = await listMonths()
    dirs = months.map((m) => `${ORDERS_DIR}/${m.slice(0, 4)}/${m.slice(5)}`)
  }

  const out: DishOrder[] = []
  for (const dir of dirs) {
    const names = normalizeNames(await fs.readdir(dir).catch(() => [] as string[]))
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const p = `${dir}/${name}`
      try {
        const text = await fs.readFile(p, 'utf8')
        const rec = typeof text === 'string' ? JSON.parse(text) : JSON.parse(new TextDecoder().decode(text))
        if (rec && typeof rec === 'object' && Array.isArray(rec.items) && typeof rec.id === 'string') {
          out.push(rec as DishOrder)
        }
      } catch (e) {
        console.warn('[dish-order] 记录解析失败，已跳过:', p, e)
      }
    }
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id).localeCompare(String(a.id)))
  return out
}

/** 写入单条记录（覆盖同 id）；写后触发一次 flush 以便远端尽快可见 */
export async function writeOrder(order: DishOrder): Promise<void> {
  const fs = getFs()
  const path = orderFilePath(order)
  await ensureDir(fs, path.slice(0, path.lastIndexOf('/')))
  await fs.writeFile(path, JSON.stringify(order))
  await flushDishGroup()
}

/** 批量写入（逐条，跳过重复 id） */
export async function writeOrders(orders: DishOrder[], overwrite = false): Promise<{ written: number; skipped: number }> {
  const existing = new Set((await readOrders()).map((o) => o.id))
  let written = 0
  let skipped = 0
  for (const order of orders) {
    if (existing.has(order.id) && !overwrite) {
      skipped++
      continue
    }
    await writeOrder(order)
    existing.add(order.id)
    written++
  }
  return { written, skipped }
}

/** 删除单条记录：优先数据组 deleteFile（墓碑），回退 unlink */
export async function deleteOrder(order: DishOrder): Promise<void> {
  const group = getGroup()
  const path = orderFilePath(order)
  try {
    if (typeof (group as any).deleteFile === 'function') {
      await (group as any).deleteFile(path)
      return
    }
  } catch (e) {
    console.warn('[dish-order] deleteFile 失败，回退 unlink:', e)
  }
  await getFs().unlink(path)
  await flushDishGroup()
}

/** 记录 id 去重判断用：把所有记录 id 载入集合 */
export async function listOrderIds(): Promise<Set<string>> {
  return new Set((await readOrders()).map((o) => o.id))
}

export { sanitizeKey }
