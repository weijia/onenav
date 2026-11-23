// 磁盘序列号推断：按卷 ID 的命名规则算出它所属物理盘的 SN，不落库、不缓存。
//
// 与 zip-browser 的 `web/host-disks-browser.js` 保持同一条规则（那边也是渲染时现算）：
//   openlist-<中间段>-<单个数字>  →  SN = 中间段
// 例：openlist-93R7SZ7KS-5 → 93R7SZ7KS
//
// 只认「末尾单个数字」（openlist 按盘序号 0/1/2/… 拼出来的那批）。
// `openlist-h99-130`、`openlist-baidu-130` 这类中间带来源名、末尾多位编号的**不猜**，
// 否则会把 `h99-13` 当成 SN；`openlist-kuake`、`openlist::C` 之类同样不猜。

const OPENLIST_SERIAL_RE = /^openlist-(.+)-[0-9]$/i

/** 从卷 ID 推断物理盘 SN；不符合规则返回空串。 */
export function deriveSerialFromVolumeId(volumeId: string | null | undefined): string {
  if (!volumeId) return ''
  const m = OPENLIST_SERIAL_RE.exec(String(volumeId).trim())
  return m ? m[1].trim() : ''
}

export interface VolumeSerialInfo {
  /** 展示用的磁盘 SN；没有则为空串 */
  serial: string
  /** 来源：telemetry = 清单/文件里本来就有；derived = 按卷 ID 推断；none = 都没有 */
  source: 'telemetry' | 'derived' | 'none'
}

/**
 * 一个卷该显示哪个磁盘 SN。
 * 优先文件里自带的 SN（`knownSerial`），缺失时才按卷 ID 推断——
 * 即「没有磁盘信息的卷」才猜，有真信息时不覆盖。
 */
export function volumeSerialInfo(
  volumeId: string | null | undefined,
  knownSerial?: string | null,
): VolumeSerialInfo {
  const known = String(knownSerial ?? '').trim()
  if (known) return { serial: known, source: 'telemetry' }
  const derived = deriveSerialFromVolumeId(volumeId)
  return derived ? { serial: derived, source: 'derived' } : { serial: '', source: 'none' }
}
