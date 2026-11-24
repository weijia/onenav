/**
 * 两个高尔夫页面（球场地图 / 球场避障导航）的共享数据层。
 *
 * 数据源：**golf 独立 PouchDB 库**（onenav-golf），不再是主库 onenav 的 app:golf 文档。
 * 拆库目的：让 golf 数据走 zen-fs-config 数据同步组（见 golf-sync.ts），与主库的
 * RemoteStorage 同步互不干扰。两个独立 Vite 入口页面同源，共享同一个 IndexedDB 库。
 *
 * 存储格式以「球场地图」的 GolfData 为权威（GCJ-02、[lng,lat]）；
 * 导航引擎需要 course-schema（WGS-84、[lat,lng]），由 golfDataToCourse() 转换。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadGolfData, migrateLegacyGolfData, saveGolfData } from '@/lib/golf-db'
import { scheduleGolfSync } from '@/lib/golf-sync'
import type { GolfData } from '@/components/apps/golf/types'
import { createDefaultGolfData } from '@/components/apps/golf/types'
import { gcj02ToWgs84 } from '@/components/apps/golf/geo'

/** 两个页面共用的 appId —— 与 config-ui 的 appId 一致，不要改 */
export const GOLF_APP_ID = 'golf'

/** 数据同步完成后派发（含数据组同步、另一页面写入）；页面收到后重新读取独立库 */
export const GOLF_DATA_CHANGED_EVENT = 'golf:data-changed'

export interface SharedGolfDataApi {
  data: GolfData
  loading: boolean
  save: (next: GolfData) => Promise<void>
  reload: () => Promise<void>
}

/** 读取并订阅共享球场数据（两个页面统一用这个 hook） */
export function useSharedGolfData(fallback?: GolfData): SharedGolfDataApi {
  const defaultData = useMemo(() => fallback ?? createDefaultGolfData(), [fallback])
  const [data, setData] = useState<GolfData>(defaultData)
  const [loading, setLoading] = useState(true)
  const [reloadTick, setReloadTick] = useState(0)
  /**
   * 只有「首次读库」才把 loading 置 true。
   *
   * 之前每次 reloadTick 变化（保存后的 golf:data-changed、同步成功后的 golf:synced）都会
   * setLoading(true)，而 GolfApp 在 loading 时直接 return 一个「正在加载球场数据…」的占位，
   * 把整棵子树（MapCanvas + GolfSyncPanel）卸载掉。于是形成死循环：
   *   同步成功 → golf:synced → loading=true → 卸载面板 → MapCanvas 重建（回到 data.center）
   *   → 面板重新挂载 → 重新 connect + attach → 再同步成功 → golf:synced → …
   * 表现出来就是地图每隔几秒「跳」一次（新建地图取默认中心，随后自动定位又 flyTo 到我的位置）。
   * 后续重读改为静默刷新：只更新 data，不卸载地图与同步面板。
   */
  const firstLoadDoneRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (!firstLoadDoneRef.current) setLoading(true)
    ;(async () => {
      await migrateLegacyGolfData()
      const d = await loadGolfData()
      if (!cancelled) setData((d as GolfData) ?? defaultData)
      firstLoadDoneRef.current = true
      if (!cancelled) setLoading(false)
    })().catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reloadTick])

  useEffect(() => {
    const onChange = () => setReloadTick((n) => n + 1)
    window.addEventListener(GOLF_DATA_CHANGED_EVENT, onChange)
    window.addEventListener('golf:synced', onChange)
    return () => {
      window.removeEventListener(GOLF_DATA_CHANGED_EVENT, onChange)
      window.removeEventListener('golf:synced', onChange)
    }
  }, [])

  const saveShared = useCallback(async (next: GolfData) => {
    setData(next)
    await saveGolfData(next)
    // 通知同源的另一个页面刷新（IndexedDB 变更事件跨页面不可靠，用事件显式广播）
    try { window.dispatchEvent(new CustomEvent(GOLF_DATA_CHANGED_EVENT)) } catch { /* ignore */ }
    scheduleGolfSync()
  }, [])

  const reload = useCallback(async () => {
    const d = await loadGolfData()
    if (d) setData(d as GolfData)
  }, [])

  return { data, loading, save: saveShared, reload }
}

// ───────────────────────────────────────────────────────────
// GolfData → 导航引擎 course-schema 转换
// ───────────────────────────────────────────────────────────

type LngLat = [number, number]
type LatLng = [number, number]

/** GCJ-02 [lng,lat] → WGS-84 [lat,lng]（导航引擎内部一律 WGS-84） */
function toNavPoint(p: LngLat | { lat: number; lng: number }): LatLng {
  const lng = Array.isArray(p) ? p[0] : p.lng
  const lat = Array.isArray(p) ? p[1] : p.lat
  const [wLng, wLat] = gcj02ToWgs84(lng, lat)
  return [wLat, wLng]
}

function toNavPath(path: LngLat[]): LatLng[] {
  return path.map(toNavPoint)
}

/** 区域类型映射到导航引擎的障碍类型 */
const AREA_TO_FEATURE: Record<string, string> = {
  water: 'water',
  bunker: 'bunker',
  rough: 'rough',
  ob: 'outOfBounds',
  woods: 'tree',
  closed: 'outOfBounds',
}

const FACILITY_TO_FEATURE: Record<string, string> = {
  water: 'water',
  bunker: 'bunker',
  fairway: 'fairway',
  cartpath: 'cartPath',
}

function circleToPolygon(center: LngLat, radiusMeters: number): LngLat[] {
  const [lng, lat] = center
  const dLat = radiusMeters / 111320
  const dLng = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180))
  const ring: LngLat[] = []
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  ring.push(ring[0])
  return ring
}

/**
 * 把共享的 GolfData 转成导航引擎可加载的 course。
 *
 * 转换规则（只做有信息依据的映射，不臆造）：
 *  - 每洞 tee/green：优先取该洞的 tee/green 设施点（无分级 tee 时取第一个），
 *    缺失则用球场中心点兜底（保证 course 结构合法）。
 *  - centerLine：GolfData 没有球道中心线，降级为 tee→green 两点连线。
 *  - 障碍：区域多边形/圆形 → 对应障碍多边形；水面/沙坑等点设施 → 小范围障碍圆。
 *  - 球车道：cartpath 设施点按洞号串成线（至少 2 点才生成）。
 */
export function golfDataToCourse(data: GolfData): any {
  const holes = data.holes && data.holes.length ? data.holes : [{ number: 1, par: 4, strokeIndex: 1 }]
  const allPoints: LatLng[] = []

  const courseHoles: any[] = []
  holes.forEach((hole) => {
    const holeFacilities = (data.facilities || []).filter((f) => f.hole === hole.number)
    const teePoint = holeFacilities.find((f) => f.type === 'tee')
    const greenPoint = holeFacilities.find((f) => f.type === 'green')
    // 没有 tee+green 标注的洞不进入导航（避免所有洞退化到同一中心点，
    // 造成栅格重叠、路线无意义）。在球场地图里补齐标注后自动可用。
    if (!teePoint || !greenPoint) return

    const tee = toNavPoint([teePoint.lng, teePoint.lat])
    const green = toNavPoint([greenPoint.lng, greenPoint.lat])
    allPoints.push(tee, green)

    const features: any[] = []
    for (const area of (data.areas || []).filter((a) => a.hole === undefined || a.hole === hole.number)) {
      const type = AREA_TO_FEATURE[area.type]
      if (!type) continue
      const path = area.kind === 'polygon' && area.path && area.path.length >= 3
        ? area.path
        : area.kind === 'circle' && area.center && area.radius
          ? circleToPolygon(area.center, area.radius)
          : null
      if (!path) continue
      const navPath = toNavPath(path)
      allPoints.push(...navPath)
      features.push({
        type,
        polygon: navPath,
        // 透传球场地图标注的真实元信息，供避障页「标注列表」显示；sourceId 用原对象 id，
        // 保证列表条目与地图几何一一对应（几何 id 仍由 buildCourseGeometry 按洞内序号生成）。
        name: area.name,
        note: area.note,
        sourceId: area.id,
      })
    }

    for (const f of holeFacilities) {
      const type = FACILITY_TO_FEATURE[f.type]
      if (!type) continue
      const polygon = toNavPath(circleToPolygon([f.lng, f.lat], f.type === 'bunker' ? 6 : 5))
      allPoints.push(...polygon)
      features.push({
        type,
        polygon,
        name: f.name,
        note: f.note,
        sourceId: f.id,
      })
    }

    // 球车道：按加入顺序串线，至少 2 点才有意义。
    const cartPoints = holeFacilities.filter((f) => f.type === 'cartpath')
    if (cartPoints.length >= 2) {
      const line = cartPoints.map((f) => toNavPoint([f.lng, f.lat]))
      allPoints.push(...line)
      features.push({
        type: 'cartPath',
        line,
        name: cartPoints.find((f) => f.name)?.name,
        sourceId: cartPoints.map((f) => f.id).join(','),
      })
    }

    // 码数线属于测量辅助，不是障碍，不进入导航几何。

    courseHoles.push({
      number: hole.number,
      par: hole.par,
      tee,
      green,
      centerLine: [tee, green],
      features,
    })
  })

  const lats = allPoints.map((p) => p[0])
  const lngs = allPoints.map((p) => p[1])
  const bounds = lats.length
    ? { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) }
    : { south: 40.04, north: 40.05, west: 116.27, east: 116.29 }

  // 保证 bounds 有非零面积（所有点重合时栅格宽高会退化）。
  if (bounds.south === bounds.north) bounds.north += 0.0002
  if (bounds.west === bounds.east) bounds.east += 0.0002

  return {
    id: GOLF_APP_ID,
    name: data.courseName || '共享球场',
    region: 'CN',
    coordinateSystem: 'WGS-84',
    bounds,
    holes: courseHoles,
  }
}

/** 同步读取当前共享数据（供非 React 上下文使用） */
export async function loadSharedCourse(): Promise<any> {
  const raw = await loadGolfData()
  return golfDataToCourse((raw as GolfData) || createDefaultGolfData())
}
