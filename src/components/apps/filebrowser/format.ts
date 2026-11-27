// 文件浏览器共用的展示格式化（目录视图 / 磁盘视图 / UFS 视图同用一份，避免多处口径漂移）。

/** 字节数 → 人类可读（KB/MB/GB…，1024 进制）；缺失返回「—」 */
export function formatSize(bytes?: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}

/** 数量 → 千分位 */
export function formatCount(n?: number | null): string {
  if (n == null) return '—'
  return n.toLocaleString('zh-CN')
}

/** 毫秒级 epoch → `YYYY-MM-DD HH:mm`（本地时区）；非法/缺失返回 null */
export function formatMtime(ms?: number | null): string | null {
  if (ms == null || !isFinite(ms)) return null
  const d = new Date(ms)
  if (isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${da} ${hh}:${mi}`
}
