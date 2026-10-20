/**
 * 高尔夫球场地图 —— 导入导出与瓦片预缓存
 *
 * 导出两种格式：
 *  1) 应用原生 JSON（GolfData 原样），用于备份与跨设备迁移；
 *  2) GeoJSON（FeatureCollection），方便与外部 GIS 工具交换。
 *
 * 坐标：两种格式都用 [lng, lat]，且为 GCJ-02（与存储一致，见 types.ts 说明）。
 *
 * 导入支持「覆盖」与「合并」：合并时按 id 匹配更新、新 id 追加，不会误删本地已有要素。
 */

import {
  uid,
  type AreaShape,
  type BasemapProvider,
  type DistanceLine,
  type FacilityPoint,
  type GolfData,
} from './types'
import { tilesInBounds } from './geo'

/** 瓦片缓存名（Service Worker 与页面共用，见 src/sw.ts） */
export const TILE_CACHE = 'golf-tiles-v1'

// ───────────────────────────────────────────────────────────
// GeoJSON 转换
// ───────────────────────────────────────────────────────────

interface GjFeature {
  type: 'Feature'
  geometry: { type: string; coordinates: unknown }
  properties: Record<string, unknown>
}

/** GolfData → GeoJSON FeatureCollection */
export function toGeoJSON(data: GolfData): { type: 'FeatureCollection'; features: GjFeature[] } {
  const features: GjFeature[] = []

  for (const f of data.facilities) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
      properties: {
        featureKind: 'facility',
        id: f.id,
        hole: f.hole,
        type: f.type,
        subtype: f.subtype,
        name: f.name,
        note: f.note,
      },
    })
  }

  for (const a of data.areas) {
    if (a.kind === 'polygon' && a.path) {
      // GeoJSON 环需闭合：首尾点相同
      const ring = [...a.path]
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first)
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {
          featureKind: 'area',
          id: a.id,
          hole: a.hole,
          type: a.type,
          kind: 'polygon',
          name: a.name,
          note: a.note,
        },
      })
    } else if (a.kind === 'circle' && a.center && a.radius) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: a.center },
        properties: {
          featureKind: 'area',
          id: a.id,
          hole: a.hole,
          type: a.type,
          kind: 'circle',
          radius: a.radius,
          name: a.name,
          note: a.note,
        },
      })
    }
  }

  for (const l of data.lines) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [l.from, l.to] },
      properties: {
        featureKind: 'line',
        id: l.id,
        hole: l.hole,
        label: l.label,
      },
    })
  }

  return { type: 'FeatureCollection', features }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** GeoJSON FeatureCollection → 部分 GolfData（只含要素，洞信息沿用本地或由调用方补齐） */
export function fromGeoJSON(text: string): Partial<GolfData> {
  const parsed = JSON.parse(text)
  const features: GjFeature[] = Array.isArray(parsed?.features)
    ? parsed.features
    : parsed?.type === 'Feature'
      ? [parsed]
      : []
  if (features.length === 0) throw new Error('GeoJSON 里没有要素')

  const facilities: FacilityPoint[] = []
  const areas: AreaShape[] = []
  const lines: DistanceLine[] = []

  for (const f of features) {
    const p = f.properties ?? {}
    const g = f.geometry ?? ({} as GjFeature['geometry'])
    const kind = p.featureKind

    if (kind === 'facility' && g.type === 'Point') {
      const [lng, lat] = g.coordinates as [number, number]
      facilities.push({
        id: str(p.id) ?? uid('f'),
        hole: num(p.hole),
        type: (str(p.type) ?? 'tee') as FacilityPoint['type'],
        subtype: str(p.subtype),
        name: str(p.name),
        note: str(p.note),
        lng,
        lat,
      })
    } else if (kind === 'area') {
      const id = str(p.id) ?? uid('a')
      const hole = num(p.hole)
      const type = (str(p.type) ?? 'water') as AreaShape['type']
      const name = str(p.name)
      const note = str(p.note)
      if (p.kind === 'circle' && g.type === 'Point') {
        areas.push({
          id,
          hole,
          type,
          name,
          note,
          kind: 'circle',
          center: g.coordinates as [number, number],
          radius: num(p.radius) ?? 50,
        })
      } else if (g.type === 'Polygon') {
        const ring = (g.coordinates as [number, number][][])[0] ?? []
        const path = ring.slice(0, ring.length - 1) // 去掉闭合重复点
        if (path.length >= 2) areas.push({ id, hole, type, name, note, kind: 'polygon', path })
      } else if (g.type === 'LineString') {
        // 兼容：有人会用 LineString 表示未闭合区域
        const path = g.coordinates as [number, number][]
        if (path.length >= 3) areas.push({ id, hole, type, name, note, kind: 'polygon', path })
      }
    } else if (kind === 'line' && g.type === 'LineString') {
      const pts = g.coordinates as [number, number][]
      if (pts.length >= 2) {
        lines.push({
          id: str(p.id) ?? uid('l'),
          hole: num(p.hole),
          label: str(p.label),
          from: pts[0],
          to: pts[pts.length - 1],
        })
      }
    }
  }

  return { facilities, areas, lines }
}

// ───────────────────────────────────────────────────────────
// 导入：识别格式 + 合并策略
// ───────────────────────────────────────────────────────────

export type ImportMode = 'replace' | 'merge'

export interface ParsedImport {
  format: 'golf' | 'geojson'
  payload: Partial<GolfData>
  counts: { facilities: number; areas: number; lines: number; holes: number }
}

/** 解析导入文本：自动识别原生 JSON 还是 GeoJSON */
export function parseImportText(text: string): ParsedImport {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('内容为空')

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    throw new Error('不是合法的 JSON')
  }

  const root = obj as Record<string, unknown>
  // 原生格式判断：有 facilities / holes 字段，或带 appId 包装
  const isNative =
    Array.isArray(root.facilities) ||
    Array.isArray(root.holes) ||
    (root.data && typeof root.data === 'object')

  if (isNative) {
    const payload = (root.data && typeof root.data === 'object' ? root.data : root) as Partial<GolfData>
    return {
      format: 'golf',
      payload,
      counts: {
        facilities: payload.facilities?.length ?? 0,
        areas: payload.areas?.length ?? 0,
        lines: payload.lines?.length ?? 0,
        holes: payload.holes?.length ?? 0,
      },
    }
  }

  if (root.type === 'FeatureCollection' || root.type === 'Feature') {
    const payload = fromGeoJSON(trimmed)
    return {
      format: 'geojson',
      payload,
      counts: {
        facilities: payload.facilities?.length ?? 0,
        areas: payload.areas?.length ?? 0,
        lines: payload.lines?.length ?? 0,
        holes: payload.holes?.length ?? 0,
      },
    }
  }

  throw new Error('无法识别：请导入本应用导出的 JSON，或标准 GeoJSON')
}

/** 按 id 合并数组：新数据覆盖同 id 项，新 id 追加 */
function mergeById<T extends { id: string }>(base: T[], incoming: T[]): T[] {
  const map = new Map<string, T>()
  for (const item of base) map.set(item.id, item)
  for (const item of incoming) map.set(item.id, item)
  return Array.from(map.values())
}

/** 把导入的数据合并进现有数据 */
export function applyImport(base: GolfData, incoming: Partial<GolfData>, mode: ImportMode): GolfData {
  if (mode === 'replace') {
    return {
      courseName: incoming.courseName ?? base.courseName,
      center: incoming.center ?? base.center,
      zoom: incoming.zoom ?? base.zoom,
      holes: incoming.holes?.length ? incoming.holes : base.holes,
      facilities: incoming.facilities ?? [],
      areas: incoming.areas ?? [],
      lines: incoming.lines ?? [],
    }
  }

  // 合并：洞按洞号，要素按 id
  const holesMap = new Map(base.holes.map((h) => [h.number, h]))
  for (const h of incoming.holes ?? []) holesMap.set(h.number, h)

  return {
    ...base,
    courseName: incoming.courseName ?? base.courseName,
    center: incoming.center ?? base.center,
    zoom: incoming.zoom ?? base.zoom,
    holes: Array.from(holesMap.values()).sort((a, b) => a.number - b.number),
    facilities: mergeById(base.facilities, incoming.facilities ?? []),
    areas: mergeById(base.areas, incoming.areas ?? []),
    lines: mergeById(base.lines, incoming.lines ?? []),
  }
}

// ───────────────────────────────────────────────────────────
// 瓦片预缓存
// ───────────────────────────────────────────────────────────

/** 把 provider 的 URL 模板渲染成真实瓦片地址 */
export function tileUrl(provider: BasemapProvider, x: number, y: number, z: number): string {
  const subs = provider.subdomains || 'abc'
  const s = subs[Math.abs(x + y) % subs.length]
  return provider.url.replace('{s}', s).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

export interface PrecacheBounds {
  south: number
  west: number
  north: number
  east: number
}

/**
 * 预缓存当前视野的瓦片（含相邻缩放级别），供离线使用。
 * 用 no-cors 抓取：瓦片是跨域图片，不需要读内容，只需落进 Cache 供离线时命中。
 */
export async function precacheTiles(
  provider: BasemapProvider,
  bounds: PrecacheBounds,
  centerZoom: number,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const cache = await caches.open(TILE_CACHE)
  const zooms = [centerZoom - 1, centerZoom, centerZoom + 1].filter(
    (z) => z >= 3 && z <= provider.maxZoom,
  )

  const jobs: string[] = []
  for (const z of zooms) {
    for (const t of tilesInBounds(bounds, z)) jobs.push(tileUrl(provider, t.x, t.y, t.z))
  }
  // 单级别瓦片数量可能爆炸，做上限保护
  const capped = jobs.slice(0, 600)

  let done = 0
  const CONCURRENCY = 6
  let cursor = 0
  const worker = async () => {
    while (cursor < capped.length) {
      const url = capped[cursor++]
      try {
        const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' })
        await cache.put(url, res)
      } catch {
        // 单张失败（网络/跨域）不影响整体，跳过
      }
      done++
      onProgress?.(done, capped.length)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return done
}
