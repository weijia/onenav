import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { FEATURE_TYPES, loadCourse } from '@/golf-nav-engine/data/course-schema.js'
import { normalizePoint } from '@/golf-nav-engine/data/coordinates.js'
import { buildGrid, worldToCell, cellToLatLng, snapToPassable, isBlocked, blockerTypeAt } from '@/golf-nav-engine/geo/passability.js'
import { latLngDistance } from '@/golf-nav-engine/geo/geometry.js'
import { findPath } from '@/golf-nav-engine/nav/astar.js'
import { adviseShot } from '@/golf-nav-engine/nav/shot-advisor.js'
import { createAdapter, sdkReady } from '@/golf-nav-engine/map-adapters/index.js'
import { buildCourseGeometry, toBusinessPoint, FEATURE_LABELS, STYLE_COLORS } from '@/golf-nav-engine/map-adapters/geometry.js'
import { golfDataToCourse, useSharedGolfData } from '@/lib/golf-shared'
import rawSampleCourse from '@/golf-nav-engine/data/sample-course.json'
import GolfSyncPanel from './GolfSyncPanel'

type Provider = 'amap' | 'tencent' | 'canvas'
type Mode = 'route' | 'shot'
type Point = { lat: number; lng: number }

const PROVIDER_LABELS: Record<Provider, string> = {
  amap: '高德地图',
  tencent: '腾讯地图',
  canvas: '矢量示意图',
}

// geometry.js 导出的是字面量对象，TS 侧补索引签名以便按分类字符串取值
const LABELS = FEATURE_LABELS as Record<string, string>
const COLORS = STYLE_COLORS as Record<string, string>

const myMarker = (p: Point, heading?: number) => ({
  id: 'me', styleId: 'me', position: toBusinessPoint(p), ...(Number.isFinite(heading) ? { heading } : {}),
})

// 键盘漫游的方向定义：heading 0=北（上），顺时针；栅格 col 向东、row 向北。
const ROAM_DIRS: Record<string, { dCol: number; dRow: number; heading: number; label: string; arrow: string }> = {
  ArrowUp: { dCol: 0, dRow: 1, heading: 0, label: '北', arrow: '↑' },
  ArrowRight: { dCol: 1, dRow: 0, heading: 90, label: '东', arrow: '→' },
  ArrowDown: { dCol: 0, dRow: -1, heading: 180, label: '南', arrow: '↓' },
  ArrowLeft: { dCol: -1, dRow: 0, heading: 270, label: '西', arrow: '←' },
}
// 每键默认前进的**实际距离**（米）。步长按米设置而不是按格数：
// 球场范围较大时 buildGrid 会自动放大栅格分辨率（可能远大于 2 米/格），
// 若仍按「格」设置步长，显示的米数会严重失真。
const DEFAULT_ROAM_STEP_METERS = 20
const ROAM_STEP_METERS = [2, 5, 10, 20, 50, 100]
// 漫游栅格半径（米）：以当前位置为中心现建，不再受球场 bounds 限制。
// 500 米半径 + 2 米分辨率 ≈ 500×500 格，重建一次也在毫秒级。
const ROAM_GRID_RADIUS_METERS = 500
// 避障漫游把**所有面状标注**都当障碍：球道、果岭、发球台、长草区、沙坑、水域、树木、界外。
// 球车道是线状导航辅助，不算区域；找路/击球决策仍用引擎默认的真障碍集合。
const ROAM_BLOCKING_TYPES = ['rough', 'fairway', 'green', 'tee', 'bunker', 'water', 'tree', 'outOfBounds']

// 键盘映射：W/A/S/D 对应 上/左/下/右；同时兼容 ↑↓←→。
// 用 e.code 优先（不受输入法/大小写影响），e.key 兜底。
const ROAM_KEY_MAP: Record<string, string> = {
  KeyW: 'ArrowUp', KeyA: 'ArrowLeft', KeyS: 'ArrowDown', KeyD: 'ArrowRight',
  w: 'ArrowUp', a: 'ArrowLeft', s: 'ArrowDown', d: 'ArrowRight',
  W: 'ArrowUp', A: 'ArrowLeft', S: 'ArrowDown', D: 'ArrowRight',
  ArrowUp: 'ArrowUp', ArrowRight: 'ArrowRight', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft',
}
const HEADING_ARROW = (h: number) => {
  const idx = ((Math.round(h / 90) % 4) + 4) % 4
  return ['↑', '→', '↓', '←'][idx]
}
// 罗盘用 8 向，比四向更能反映手机实际朝向。
const COMPASS_ARROW = (h: number) => {
  const idx = ((Math.round(h / 45) % 8) + 8) % 8
  return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][idx]
}

export default function GolfNavApp() {
  const { data: sharedData, loading: sharedLoading } = useSharedGolfData()
  // 共享数据（球场地图标注）优先；尚无 tee/green 标注时回退内置示例球场。
  const course = useMemo(() => {
    const converted = golfDataToCourse(sharedData)
    const result = loadCourse(converted)
    if (result.ok && result.course.holes.length > 0) return result.course
    return loadCourse(rawSampleCourse as any).course
  }, [sharedData])
  const usingShared = useMemo(
    () => golfDataToCourse(sharedData).holes.length > 0,
    [sharedData],
  )
  const mapEl = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<any>(null)
  const courseGeom = useMemo(() => buildCourseGeometry(course), [course])

  const [provider, setProvider] = useState<Provider>('amap')
  const [mode, setMode] = useState<Mode>('route')
  const [syncOpen, setSyncOpen] = useState(false)
  const [hole, setHole] = useState(1)
  const [target, setTarget] = useState<'tee' | 'green'>('green')
  const [position, setPosition] = useState<Point | null>(null)
  const [result, setResult] = useState('正在获取当前位置…')
  const [notice, setNotice] = useState('')
  // 分类筛选支持多选：空数组 = 只看当前洞的全部；选中若干类 = 只看这些类（跨所有洞）。
  const [activeTypes, setActiveTypes] = useState<string[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [roaming, setRoaming] = useState(false)
  const [heading, setHeading] = useState<number>(0) // 0=北，顺时针
  const [roamHint, setRoamHint] = useState('')
  // 手机方向（罗盘）：0=北，顺时针；null 表示还没有有效读数。
  // 只有 webkitCompassHeading 或 absolute 事件才可信，普通 alpha 是相对值，不用。
  const [deviceHeading, setDeviceHeading] = useState<number | null>(null)
  const [compassState, setCompassState] = useState<'unsupported' | 'idle' | 'on' | 'denied'>(
    typeof window !== 'undefined' && typeof (window as any).DeviceOrientationEvent !== 'undefined' ? 'idle' : 'unsupported',
  )
  const [roamStepMeters, setRoamStepMeters] = useState(DEFAULT_ROAM_STEP_METERS) // 每键前进的实际距离（米）
  const routeRef = useRef<any[] | null>(null)
  const positionRef = useRef<Point | null>(null)
  const headingRef = useRef<number>(0)
  const deviceHeadingRef = useRef<number | null>(null)
  const compassSmoothRef = useRef<number | null>(null)
  const lastCompassPaintRef = useRef(0)
  const roamGridRef = useRef<any>(null)
  const viewCenterRef = useRef<Point | null>(null) // 上次地图居中点，用于漫游时延迟跟随
  const roamingRef = useRef(false)
  const autoLocatedRef = useRef(false) // 首次建图后只自动定位一次，切底图不重复打断视野
  const locatingRef = useRef(false) // 定位进行中，避免连点或严格模式双挂载重复请求

  // 当前应高亮的几何 id：选中的单个标注优先；否则聚焦分类时高亮该分类跨所有洞的全部区域
  const highlightIds = useMemo(() => {
    if (selected) return [selected.id] as string[]
    // 选中（含全选）的分类统一高亮：全选时就是把所有标注都点亮，
    // 否则只落到 baseStyle（细线+低填充），在亮底图上几乎看不见。
    if (activeTypes.length >= (FEATURE_TYPES as string[]).length) {
      return [
        ...courseGeom.polygons.map((p: any) => p.id),
        ...courseGeom.lines.filter((l: any) => l.styleId !== 'center').map((l: any) => l.id),
      ] as string[]
    }
    if (activeTypes.length) {
      return [
        ...courseGeom.polygons.filter((p: any) => activeTypes.includes(p.featureType)).map((p: any) => p.id),
        ...courseGeom.lines.filter((l: any) => l.styleId !== 'center' && activeTypes.includes(l.featureType)).map((l: any) => l.id),
      ] as string[]
    }
    return [] as string[]
  }, [selected, activeTypes, courseGeom])
  const highlightIdsRef = useRef<string[]>([])
  highlightIdsRef.current = highlightIds

  // 分类筛选只排除「已知类型且未被选中」的要素；未知类型一律保留。
  // 否则全选 9 个已知类型时，数据里若有不在 FEATURE_TYPES 里的自定义标注会被滤掉，
  // 看上去就像「点了全部显示反而什么都没了」。
  const passType = useCallback((ft?: string) => {
    if (!activeTypes.length) return true
    const known = FEATURE_TYPES as string[]
    if (!ft || !known.includes(ft)) return true
    return activeTypes.includes(ft)
  }, [activeTypes])

  // 只重画「我的位置」标记：罗盘转动时会高频触发，必须轻量。
  const drawMyMarker = useCallback(() => {
    const a = adapterRef.current
    if (!a) return
    const p = positionRef.current
    const h = roamingRef.current ? (deviceHeadingRef.current ?? headingRef.current) : undefined
    a.setMarkers(p ? [myMarker(p, h)] : [])
  }, [])

  // 统一绘制「我的位置」：me 标记始终在最前，extras 用于叠加击球建议的候选点
  // 漫游开启时标记带朝向箭头：有手机罗盘就跟手机转，没有才用最近一次按键方向。
  const syncMyPosition = useCallback((p: Point | null, extras: any[] = []) => {
    positionRef.current = p
    const a = adapterRef.current
    if (!a) return
    const h = roamingRef.current ? (deviceHeadingRef.current ?? headingRef.current) : undefined
    a.setMarkers(p ? [myMarker(p, h), ...extras] : extras)
  }, [])

  // ===== 手机方向（罗盘）=====
  // iOS 用 webkitCompassHeading（真磁北），Android 用 absolute 事件（alpha 取反）。
  // 屏幕旋转角要补偿，读数做 EMA 平滑；角度变化小于 4° 不重绘，避免箭头抖动。
  useEffect(() => {
    const apply = (rawHeading: number) => {
      if (!Number.isFinite(rawHeading)) return
      const rawSo = (typeof screen !== 'undefined' ? (screen as any).orientation?.angle : 0)
      const so = Number(rawSo ?? (window as any).orientation ?? 0) || 0
      const abs = (((rawHeading + so) % 360) + 360) % 360
      const prev = compassSmoothRef.current
      let next = abs
      if (prev != null) {
        let d = abs - prev
        if (d > 180) d -= 360
        if (d < -180) d += 360
        next = (((prev + d * 0.25) % 360) + 360) % 360
      }
      compassSmoothRef.current = next
      const last = deviceHeadingRef.current
      const moved = last == null || Math.abs(((next - last + 540) % 360) - 180) > 4
      deviceHeadingRef.current = next
      // 角度整数变了才 setState：EMA 收敛时的零点几度抖动不会重渲染，
      // 也不会像固定阈值那样把 12° 这种残留值一直挂在界面上。
      if (Math.round(next) !== Math.round(last ?? -1)) {
        setDeviceHeading(next)
        setCompassState((s) => (s === 'on' ? s : 'on'))
      }
      const now = performance.now()
      if (moved && roamingRef.current && now - lastCompassPaintRef.current > 200) {
        lastCompassPaintRef.current = now
        drawMyMarker()
      }
    }
    const onOrient = (e: any) => {
      const h = typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0
        ? e.webkitCompassHeading
        : (e.absolute === true && typeof e.alpha === 'number' ? 360 - e.alpha : null)
      if (h != null) apply(h)
    }
    window.addEventListener('deviceorientationabsolute', onOrient, true)
    window.addEventListener('deviceorientation', onOrient, true)
    return () => {
      window.removeEventListener('deviceorientationabsolute', onOrient, true)
      window.removeEventListener('deviceorientation', onOrient, true)
    }
  }, [drawMyMarker])

  // iOS 必须在用户手势里申请方向权限；桌面 Chrome 有这个事件但没有传感器，
  // 打开后 3 秒仍无读数就判定为「本设备没有可用罗盘」。
  const enableCompass = useCallback(async () => {
    const D = (window as any).DeviceOrientationEvent
    if (!D) { setCompassState('unsupported'); return }
    try {
      if (typeof D.requestPermission === 'function') {
        const r = await D.requestPermission()
        if (r !== 'granted') { setCompassState('denied'); return }
      }
      setCompassState('idle')
      window.setTimeout(() => {
        if (deviceHeadingRef.current == null) setCompassState('unsupported')
      }, 3000)
    } catch {
      setCompassState('denied')
    }
  }, [])

  // 按分类过滤后的几何；未选中分类时显示全部，选中时只显示该分类（跨所有洞）。
  // 中心线属于辅助线，始终显示。
  const displayGeom = useMemo(() => ({
    polygons: courseGeom.polygons.filter((p: any) => passType(p.featureType)),
    lines: courseGeom.lines.filter((l: any) => l.styleId === 'center' || passType(l.featureType)),
  }), [courseGeom, passType])

  // 按分类分组的标注列表：选中某分类时列出该分类跨所有洞的全部区域；
  // 未选中时仅列当前洞。排除中心线辅助线。
  // 名称来自球场地图真实标注（经 golfDataToCourse → buildCourseGeometry 透传），无名称时按类型+序号兜底。
  const featureGroups = useMemo(() => {
    const geoms: any[] = [
      ...courseGeom.polygons.map((g: any) => ({ ...g, geomKind: 'polygon' })),
      ...courseGeom.lines
        .filter((l: any) => l.styleId !== 'center')
        .map((l: any) => ({ ...l, geomKind: 'line' })),
    ].filter((g: any) => activeTypes.length ? passType(g.featureType) : g.hole === hole)
    const map = new Map<string, any[]>()
    for (const g of geoms) {
      const key = g.featureType || g.styleId || 'other'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(g)
    }
    return map
  }, [courseGeom, hole, activeTypes, passType])

  const currentHole = useMemo(
    () => course.holes.find((h: any) => h.number === hole) || course.holes[0],
    [course, hole],
  )

  const center = useMemo<Point>(() => {
    const b = course.bounds
    return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 }
  }, [course])

  // keepZoom=true 时只平移、不改缩放：漫游跟随不应重置用户手动调整的比例尺。
  // 用能力探测代替 provider 分支：initMap 里的 setProvider 是异步 state，
  // 自动定位的回调可能早于它生效，按 provider 判断会走到错误的适配器。
  // canvas 适配器没有视口概念（始终按 bounds 铺满），这里会静默返回。
  const centerOn = useCallback((p: Point, keepZoom = false, zoom = 16) => {
    const a = adapterRef.current
    if (!a || !a.map || !a.toDisplayPoint) return
    try {
      const display = a.toDisplayPoint(p)
      const m: any = a.map
      if (keepZoom) {
        // 只平移：Leaflet 有 panTo，回退时保留当前 zoom
        if (typeof m.panTo === 'function') m.panTo(display)
        else if (typeof m.setView === 'function') m.setView(display, typeof m.getZoom === 'function' ? m.getZoom() : zoom)
        else if (typeof m.setCenter === 'function') m.setCenter(display)
      } else if (typeof m.setView === 'function') {
        m.setView(display, zoom)
      } else if (typeof m.setCenter === 'function') {
        m.setCenter(display)
      }
      viewCenterRef.current = p
    } catch { /* ignore */ }
  }, [])

  // 漫游时不要每走一步都把标记钉在屏幕中心（那样看起来标记没动）；
  // 只有离上次居中点超过 60 米才重新居中，且保留当前缩放（比例尺不跳变）。
  const followIfNeeded = useCallback((p: Point) => {
    const c = viewCenterRef.current
    if (!c || latLngDistance(c, p) > 60) centerOn(p, true)
  }, [centerOn])

  // 从「标注列表」点击一条：构造与地图点击一致的 hit，复用同一套高亮链路；并把地图定位到该标注。
  const selectFromList = useCallback((g: any) => {
    const hit = {
      id: g.id,
      featureType: g.featureType,
      hole: g.hole,
      featureIndex: g.featureIndex,
      styleId: g.styleId,
      name: g.name,
      sourceId: g.sourceId,
      kind: g.geomKind,
    }
    setSelected(hit)
    // 取几何顶点的中心作为定位点，避免飞到某个角落
    if (g.paths && g.paths.length) {
      const lat = g.paths.reduce((s: number, p: any) => s + p.lat, 0) / g.paths.length
      const lng = g.paths.reduce((s: number, p: any) => s + p.lng, 0) / g.paths.length
      centerOn({ lat, lng })
    }
  }, [centerOn])

  // 单次定位请求：Promise 化 + 兜底计时器。
  // Windows 的系统定位服务冷启动常常超过 8 秒，而且部分实现里 getCurrentPosition 的
  // timeout 参数并不生效（系统侧挂起时会一直不回调），所以另加计时器保证一定收尾。
  const requestPosition = useCallback((timeout = 20000) => new Promise<GeolocationPosition | null>((resolve) => {
    if (!navigator.geolocation) { resolve(null); return }
    let settled = false
    let guard: ReturnType<typeof setTimeout> | undefined
    const finish = (v: GeolocationPosition | null) => {
      if (settled) return
      settled = true
      if (guard) clearTimeout(guard)
      resolve(v)
    }
    guard = setTimeout(() => finish(null), timeout + 3000)
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => finish(pos),
        () => finish(null),
        { enableHighAccuracy: true, timeout, maximumAge: 0 },
      )
    } catch { finish(null) }
  }), [])

  // 定位并落到地图。auto=true 是「打开页面即定位」，失败时不再伪装成定位成功。
  const locate = useCallback(async (opts: { auto?: boolean } = {}) => {
    if (locatingRef.current) return
    locatingRef.current = true
    const tee = normalizePoint(currentHole.tee)
    try {
      if (!navigator.geolocation) {
        setPosition(tee)
        syncMyPosition(tee)
        setResult('浏览器不支持定位，已使用本洞发球台作为参考位置。')
        return
      }
      setResult('正在获取当前位置…')
      // 冷启动第一次经常超时，失败后再请求一次
      let pos = await requestPosition(20000)
      if (!pos) pos = await requestPosition(20000)
      if (!pos) {
        if (opts.auto) {
          setResult('未能获取定位（可能未授权，或系统定位服务未开启），地图仍按球场中心显示；可点「定位」重试，或直接点地图手动设置。')
        } else {
          setPosition(tee)
          syncMyPosition(tee)
          setResult('定位不可用，已使用本洞发球台作为参考位置；可点击地图手动设置。')
        }
        return
      }
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }
      const acc = Math.round(pos.coords.accuracy)
      const dist = latLngDistance(p, center)
      setPosition(p)
      syncMyPosition(p)
      // 桌面端只有 IP/WiFi 级的百米精度，定位点常远离球场；此时按 16 级缩放只会看到空白，
      // 退到 13 级让球场和当前位置同时可见。
      centerOn(p, false, dist > 2000 ? 13 : 16)
      const head = acc > 50
        ? `已按当前位置显示（精度约 ${acc} 米；桌面端通常只有百米级，球场内建议点地图校准）`
        : `定位成功（精度约 ${acc} 米）`
      setResult(dist > 2000
        ? `${head}。\n当前位置距球场中心约 ${(dist / 1000).toFixed(1)} 公里，可切换洞号回到球场视野。`
        : `${head}。`)
    } finally {
      locatingRef.current = false
    }
  }, [currentHole, center, requestPosition, syncMyPosition, centerOn])

  const initMap = useCallback((p: Provider) => {
    if (!mapEl.current) return
    try {
      if (adapterRef.current) adapterRef.current.destroy()
      if (!sdkReady(p, { TMap: (window as any).TMap, L })) {
        setNotice(`${PROVIDER_LABELS[p]}加载失败，已切换为矢量示意图。`)
        p = 'canvas'
      }
      const adapter = createAdapter(p, { region: course.region, L, course, canvas: mapEl.current })
      adapter.create(mapEl.current, center, 16)
      viewCenterRef.current = center
      adapterRef.current = adapter
      adapter.setPolygons(displayGeom.polygons)
      adapter.setLines([
        ...displayGeom.lines,
        ...(routeRef.current ? [{ id: 'route', styleId: 'route', paths: routeRef.current.map(toBusinessPoint) }] : []),
      ])
      adapter.onClick((pt: Point) => {
        setPosition(pt)
        syncMyPosition(pt)
        setSelected(null)
        setResult('已手动设置位置。')
      })
      adapter.onFeatureClick((hit: any) => {
        setSelected(hit)
      })
      // 初始化后立即应用当前高亮（选中标注或聚焦分类）
      adapter.setSelection(highlightIdsRef.current)
      if (positionRef.current) {
        adapter.setMarkers([myMarker(positionRef.current, roamingRef.current ? headingRef.current : undefined)])
      }
      setProvider(p)
      setNotice('')
      // 打开页面即定位：只在首次建图后触发，切底图时不重复打断用户视野。
      // 放在 create 之后执行，确保定位回来时 adapterRef 已有值，标记和居中都能生效。
      if (!autoLocatedRef.current) {
        autoLocatedRef.current = true
        void locate({ auto: true })
      }
    } catch (e: any) {
      setNotice(`地图初始化失败：${e.message}`)
    }
  }, [course, center, displayGeom, syncMyPosition, locate])

  // 分类筛选/切洞后的图层同步，保留已有路线；高亮由 syncHighlight 单独负责
  const applyLines = useCallback(() => {
    const a = adapterRef.current
    if (!a) return
    a.setLines([
      ...displayGeom.lines,
      ...(routeRef.current ? [{ id: 'route', styleId: 'route', paths: routeRef.current.map(toBusinessPoint) }] : []),
    ])
  }, [displayGeom])

  // 统一的高亮同步：选中单个标注时高亮它；聚焦分类时高亮该分类全部区域；
  // 两者都无则清空。图层重建后也会重新应用。
  const syncHighlight = useCallback(() => {
    const a = adapterRef.current
    if (a) a.setSelection(highlightIdsRef.current)
  }, [])

  useEffect(() => {
    const a = adapterRef.current
    if (!a) return
    a.course = course
    a.setPolygons(displayGeom.polygons)
    applyLines()
  }, [course, displayGeom, applyLines])

  // 高亮状态变化时同步到地图
  useEffect(() => { syncHighlight() }, [highlightIds, syncHighlight])

  useEffect(() => {
    initMap('amap')
    return () => { try { adapterRef.current && adapterRef.current.destroy() } catch { /* ignore */ } }
  }, [])

  const ensureGrid = () => {
    const parts = [
      currentHole.tee, currentHole.green, ...currentHole.centerLine,
      ...(currentHole.features || []).flatMap((f: any) => [f.polygon, f.line, f.point].filter(Boolean)),
    ]
    // 单个洞的合理半径：远超最长球洞（约 600 米），但能挡住 (0,0) 一类野点
    // 把 bounds 撑到几十公里，进而触发 buildGrid 自动放大栅格分辨率。
    const tee = normalizePoint(currentHole.tee)
    const green = normalizePoint(currentHole.green)
    const anchor = {
      lat: (tee.lat + green.lat) / 2,
      lng: (tee.lng + green.lng) / 2,
    }
    const plausible = (lat: number, lng: number) =>
      Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      && latLngDistance({ lat, lng }, anchor) <= 5000

    // 递归收集全部坐标：点可为 [lat,lng] / {lat,lng} / 类数组，polygon/line 是「点数组」。
    // 之前只取 p[0]，把 polygon 的点数组塞进 Math.min → bounds 变 NaN → 漫游坐标全变 NaN。
    const collect = (v: any, out: number[], wantLat: boolean) => {
      if (v == null) return
      if (Array.isArray(v)) {
        if (v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
          if (plausible(Number(v[0]), Number(v[1]))) out.push(wantLat ? Number(v[0]) : Number(v[1]))
        } else {
          v.forEach((q: any) => collect(q, out, wantLat))
        }
      } else if (typeof v === 'object') {
        const a = typeof v.lat === 'number' ? v.lat : Number(v[0])
        const b = typeof v.lng === 'number' ? v.lng : Number(v[1])
        if (plausible(a, b)) out.push(wantLat ? a : b)
      }
    }
    const lats: number[] = []
    const lngs: number[] = []
    parts.forEach((p: any) => { collect(p, lats, true); collect(p, lngs, false) })
    const derived = lats.length && lngs.length
      ? { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) }
      : course.bounds
    const bounds = [derived.south, derived.north, derived.west, derived.east].every(Number.isFinite)
      ? derived : course.bounds
    return buildGrid(course, { resolutionMeters: 2, holeNumbers: [hole], bounds })
  }

  const cellFor = (p: Point) => {
    const g = ensureGrid()
    const c = worldToCell(g, p)
    return snapToPassable(g, c.col, c.row) || c
  }

  // ===== 键盘漫游 =====
  // 栅格以「当前位置」为中心现建，半径 ROAM_GRID_RADIUS_METERS，不再受球场 bounds 约束。
  // 原实现用球场栅格：人站在场外时 worldToCell 会把坐标钳到网格边界，边界又被
  // 界外区的膨胀格占满、snapToPassable 追不上来，四个方向全部 isBlocked，标记纹丝不动。
  // 现在网格跟着人走：附近若有球场要素就照常避障，没有标注的地方按开阔地处理。
  const ensureRoamGrid = useCallback((anchor: Point) => {
    const cached = roamGridRef.current
    // 走出一半半径再重建，避免每按一次键都重算
    if (cached && latLngDistance(cached.anchor, anchor) < ROAM_GRID_RADIUS_METERS * 0.5) {
      return cached.grid
    }
    const r = ROAM_GRID_RADIUS_METERS
    const dLat = r / 111320
    const dLng = r / (111320 * Math.max(0.2, Math.cos((anchor.lat * Math.PI) / 180)))
    const grid = buildGrid(course, {
      origin: anchor,
      bounds: {
        south: anchor.lat - dLat, north: anchor.lat + dLat,
        west: anchor.lng - dLng, east: anchor.lng + dLng,
      },
      resolutionMeters: 2,
      blockingTypes: ROAM_BLOCKING_TYPES,
    })
    roamGridRef.current = { anchor, grid }
    return grid
  }, [course])

  // 漫游用的栅格：始终以当前位置为锚点（没有位置时才退回本洞发球台）
  const getRoamGrid = useCallback(() => {
    const p = positionRef.current || normalizePoint(currentHole.tee)
    return ensureRoamGrid(p)
  }, [ensureRoamGrid, currentHole])

  // 当前位置所在的可通行格；若落在障碍内则吸附到最近可通行格
  const roamCell = useCallback((p: Point) => {
    const g = getRoamGrid()
    const c = worldToCell(g, p)
    return snapToPassable(g, c.col, c.row) || c
  }, [getRoamGrid])

  const buildRoamHint = useCallback((cell: { col: number; row: number }) => {
    const g = getRoamGrid()
    const walkable: string[] = []
    const blockedNotes: string[] = []
    for (const dir of Object.values(ROAM_DIRS)) {
      const c = cell.col + dir.dCol
      const r = cell.row + dir.dRow
      if (isBlocked(g, c, r)) {
        const type = blockerTypeAt(g, c, r)
        const name = type ? (LABELS[type] || type) : '边界'
        blockedNotes.push(`${dir.arrow}${dir.label}：${name}`)
      } else {
        walkable.push(`${dir.arrow}${dir.label}`)
      }
    }
    const walk = walkable.length ? walkable.join(' ') : '无'
    const blocked = blockedNotes.length ? `；受阻 ${blockedNotes.join('、')}` : ''
    return `可走：${walk}${blocked}`
  }, [getRoamGrid])

  // 手机方向下的「该往哪走」：在四向可走方向里选与手机朝向夹角最小的那个。
  // 只给一步建议，不做多步绕行；四向全堵时提示先移出标注区域。
  const compassHint = useMemo(() => {
    if (!roaming || !position || deviceHeading == null) return null
    const g = getRoamGrid()
    const cell = roamCell(position)
    const ref = deviceHeading
    const cands = Object.values(ROAM_DIRS).map((d) => {
      const blocked = isBlocked(g, cell.col + d.dCol, cell.row + d.dRow)
      let diff = d.heading - ref
      if (diff > 180) diff -= 360
      if (diff < -180) diff += 360
      return { d, blocked, diff }
    })
    const walkable = cands.filter((c) => !c.blocked)
    if (!walkable.length) return { allBlocked: true, dir: null as any, diff: 0, turn: '' }
    walkable.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))
    const best = walkable[0]
    const turn = Math.abs(best.diff) < 8
      ? '正前方'
      : `${Math.round(Math.abs(best.diff) / 5) * 5}° ${best.diff > 0 ? '右转' : '左转'}`
    return { allBlocked: false, dir: best.d as any, diff: best.diff, turn }
  }, [roaming, position, deviceHeading, getRoamGrid, roamCell])

  // 走一步：箭头先转向该方向；按「米」换算成格数连续前进，遇到障碍即停在前一格。
  // 步长按米而非格，避免栅格分辨率被自动放大时实际距离与显示值不符。
  const roamStep = useCallback((dirKey: string) => {
    const dir = ROAM_DIRS[dirKey]
    if (!dir) return
    headingRef.current = dir.heading
    setHeading(dir.heading)
    const p = positionRef.current
    if (!p) { setResult('请先定位或点击地图设置位置，再开始键盘漫游。'); return }
    const cell = roamCell(p)
    const g = getRoamGrid()
    if (!Number.isFinite(cell.col) || !Number.isFinite(cell.row)) {
      setResult('当前位置坐标无效，请重新定位或点击地图设置位置。')
      return
    }
    // 实际栅格分辨率可能因球场范围过大被 buildGrid 放大；按米数反推本次要走多少格。
    const stepCells = Math.max(1, Math.round(roamStepMeters / (Number(g.resolution) || 2)))
    let nc = cell.col
    let nr = cell.row
    for (let step = 0; step < stepCells; step++) {
      const tc = nc + dir.dCol
      const tr = nr + dir.dRow
      if (isBlocked(g, tc, tr)) break
      nc = tc
      nr = tr
    }
    const moved = Math.abs(nc - cell.col) + Math.abs(nr - cell.row)
    if (moved === 0) {
      // 边缘外即停：位置不变，仅刷新朝向标记与提示
      syncMyPosition(p)
      setRoamHint(buildRoamHint(cell))
      setResult(`朝${dir.label}被阻挡，停在障碍边缘。`)
      return
    }
    const next = cellToLatLng(g, nc, nr)
    if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) {
      setResult('移动计算出现异常坐标，已保留原位置；请重新定位。')
      return
    }
    setPosition(next)
    syncMyPosition(next)
    followIfNeeded(next)
    setRoamHint(buildRoamHint({ col: nc, row: nr }))
    // 用真实经纬度算距离，而不是「格数 × 分辨率」，确保显示的米数与地图一致。
    const realMeters = latLngDistance(p, next)
    setResult(`已朝${dir.label}移动 ${realMeters.toFixed(1)} 米${moved < stepCells ? '（前方受阻，已停在边缘）' : ''}。`)
  }, [roamCell, getRoamGrid, syncMyPosition, followIfNeeded, buildRoamHint, roamStepMeters])

  // 键盘监听：仅漫游开启时接管 WASD / 方向键。
  // 用 capture 阶段抢在地图（Leaflet/高德）之前处理，避免地图把方向键当平移。
  useEffect(() => {
    if (!roaming) return
    const onKeyDown = (e: KeyboardEvent) => {
      const dirKey = ROAM_KEY_MAP[e.code] || ROAM_KEY_MAP[e.key]
      if (!dirKey) return
      // 输入框（如同步面板表单）聚焦时不劫持按键
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      e.stopPropagation()
      roamStep(dirKey)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [roaming, roamStep])

  // 位置/洞号/开关变化后自动刷新可走提示（覆盖点击设点、定位、切洞等所有路径）
  useEffect(() => {
    if (!roaming || !positionRef.current) return
    setRoamHint(buildRoamHint(roamCell(positionRef.current)))
  }, [roaming, position, hole, buildRoamHint, roamCell])

  const toggleRoaming = () => {
    const next = !roaming
    roamingRef.current = next
    setRoaming(next)
    if (next) {
      // 起点以渲染中的 position 为准：自动定位是异步的，ref 可能落后于 state。
      // 取到后回写 ref，后面 roamStep / getRoamGrid 统一读 ref。
      const start = position || positionRef.current
      if (start) positionRef.current = start
      if (!start) {
        const tee = normalizePoint(currentHole.tee)
        setPosition(tee)
        syncMyPosition(tee)
        setRoamHint(buildRoamHint(roamCell(tee)))
        setResult('键盘漫游已开启：用 W A S D / ↑↓←→ / 屏幕方向键移动，点击地图可重设起点。')
      } else {
        syncMyPosition(start) // 立即重绘为带箭头标记
        setRoamHint(buildRoamHint(roamCell(start)))
        // 起点若落在某个标注区域内，四向都会被挡；直接把原因说清楚，避免看起来「标记不动」。
        const g = getRoamGrid()
        const raw = worldToCell(g, start)
        const cover = isBlocked(g, raw.col, raw.row) ? blockerTypeAt(g, raw.col, raw.row) : null
        setResult(cover
          ? `键盘漫游已开启（朝向${HEADING_ARROW(headingRef.current)}）。\n当前位置落在「${LABELS[cover] || cover}」标注范围内，四向都会被挡住；请点击地图移到标注外再走。`
          : `键盘漫游已开启（朝向${HEADING_ARROW(headingRef.current)}）：用 W A S D / ↑↓←→ / 屏幕方向键移动，所有标注区域都会被绕开。`)
      }
    } else {
      syncMyPosition(positionRef.current) // 立即重绘回普通圆点
      setRoamHint('')
      setResult('键盘漫游已关闭。')
    }
  }

  const calculateRoute = () => {
    if (!position) { setResult('请先定位或点击地图设置位置。'); return }
    const goal = target === 'tee' ? currentHole.tee : currentHole.green
    const r = findPath(ensureGrid(), cellFor(position), cellFor(goal as Point), { mode: 'walk' })
    if (!r.found) { setResult('当前位置到目标无可行路线。'); return }
    const pts = r.points.map((c: any) => cellToLatLng(ensureGrid(), c.col, c.row))
    routeRef.current = pts
    applyLines()
    syncMyPosition(position)
    let dist = 0
    for (let i = 1; i < pts.length; i++) dist += latLngDistance(pts[i - 1], pts[i])
    setResult(`路线已生成\n目标：${target === 'tee' ? '发球台' : '果岭'}\n折线距离约 ${dist.toFixed(0)} 米\n路线点数 ${pts.length}`)
  }

  const calculateShot = () => {
    if (!position) { setResult('请先定位或点击地图设置位置。'); return }
    const r = adviseShot(ensureGrid(), position, currentHole.green)
    if (!r.ok || !r.recommended) { setResult(r.reason || '无法生成建议'); return }
    syncMyPosition(position, [
      { id: 'green', styleId: 'target', position: toBusinessPoint(currentHole.green) },
      ...r.candidates.slice(0, 6).map((c: any, i: number) => ({ id: `land${i}`, styleId: 'landing', position: toBusinessPoint(c.latLng) })),
    ])
    setResult(`${r.recommended.kind}\n推荐落点风险分 ${r.recommended.risk}（越低越安全）\n${r.disclaimer || ''}`)
  }

  const changeHole = (n: number) => {
    setHole(n)
    const h = course.holes.find((x: any) => x.number === n) || course.holes[0]
    routeRef.current = null
    setSelected(null)
    if (adapterRef.current) applyLines()
    syncMyPosition(position)
    const tee = normalizePoint(h.tee); const green = normalizePoint(h.green)
    centerOn({ lat: (tee.lat + green.lat) / 2, lng: (tee.lng + green.lng) / 2 })
    setResult(`已切换到第 ${n} 洞。`)
  }

  return (
    <div className="flex flex-col gap-3 p-4 h-full text-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <select value={provider} onChange={(e) => initMap(e.target.value as Provider)} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-800 shadow-sm">
          {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
        </select>
        <select value={hole} onChange={(e) => changeHole(Number(e.target.value))} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-800 shadow-sm">
          {course.holes.map((h: any) => <option key={h.number} value={h.number}>第 {h.number} 洞 · Par {h.par}</option>)}
        </select>
        <button onClick={() => { void locate() }} className="rounded border border-slate-300 bg-white px-3 py-1 text-slate-800 shadow-sm hover:bg-slate-100">定位</button>
        <button
          onClick={toggleRoaming}
          className={`rounded px-3 py-1 shadow-sm ${roaming ? 'bg-sky-600 text-white ring-1 ring-sky-300' : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100'}`}
          title="用键盘上下左右键控制带方向的标记移动，自动避开障碍"
        >{roaming ? '■ 停止漫游' : '▶ 键盘漫游'}</button>
        <div className="flex rounded overflow-hidden border border-slate-300 shadow-sm">
          <button onClick={() => setMode('route')} className={`px-3 py-1 ${mode === 'route' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-800'}`}>场内找路</button>
          <button onClick={() => setMode('shot')} className={`px-3 py-1 ${mode === 'shot' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-800'}`}>击球决策</button>
        </div>
      </div>

      {notice && <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</div>}
      <p className="text-xs text-slate-500">
        数据源：{usingShared ? '球场地图共享标注（独立库 golf）' : '内置示例球场（共享数据尚无 tee/green 标注）'}
        {sharedLoading ? ' · 加载中…' : ''}
      </p>

      <div className="flex flex-col md:flex-row gap-3 flex-1 min-h-0">
        <div className="w-full md:w-64 shrink-0 flex flex-col gap-3">
          <div className="rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm">
            <h3 className="font-medium mb-2">状态</h3>
            <p className="text-sm whitespace-pre-line leading-relaxed">{result}</p>
          </div>
          {roaming && (
            <div className="rounded-lg bg-sky-50 p-3 ring-1 ring-sky-200">
              <h3 className="font-medium mb-2">漫游提示</h3>
              <p className="text-sm mb-1">
                朝向：<span className="text-sky-600 text-lg">{HEADING_ARROW(heading)}</span>
                <span className="opacity-70 ml-1">（{heading}°）</span>
              </p>
              {deviceHeading != null ? (
                <p className="text-sm mb-1">
                  手机朝向：<span className="text-emerald-600 text-lg">{COMPASS_ARROW(deviceHeading)}</span>
                  <span className="opacity-70 ml-1">（{Math.round(deviceHeading)}°）</span>
                </p>
              ) : compassState !== 'on' ? (
                <button
                  type="button"
                  onClick={() => void enableCompass()}
                  className="mb-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 shadow-sm hover:bg-slate-100"
                >
                  {compassState === 'denied' ? '方向权限被拒，点此重试'
                    : compassState === 'unsupported' ? '本设备没有可用罗盘'
                    : '开启手机方向'}
                </button>
              ) : null}
              <p className="text-sm mb-1 font-mono">
                坐标：<span className="text-sky-700">{position && Number.isFinite(position.lat) && Number.isFinite(position.lng) ? `${position.lat.toFixed(6)}, ${position.lng.toFixed(6)}` : '未设置或无效'}</span>
              </p>
              <p className="text-sm whitespace-pre-line leading-relaxed">{roamHint || '正在计算可走方向…'}</p>
              {compassHint && (
                <p className="text-sm mt-1 text-emerald-700">
                  {compassHint.allBlocked
                    ? '四向都被挡住：先退出当前标注区域再走。'
                    : `建议：${compassHint.dir.arrow} ${compassHint.dir.label}（${compassHint.turn}）`}
                </p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <label htmlFor="roam-step" className="text-xs opacity-70">每键步长</label>
                <select
                  id="roam-step"
                  value={roamStepMeters}
                  onChange={(e) => setRoamStepMeters(Number(e.target.value))}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 shadow-sm"
                >
                  {ROAM_STEP_METERS.map((m) => <option key={m} value={m}>{m} 米</option>)}
                </select>
                <span className="text-xs opacity-50">当前精度 {getRoamGrid().resolution} 米/格</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1 w-max mx-auto select-none" aria-label="屏幕方向键">
                <span />
                <button type="button" onClick={() => roamStep('ArrowUp')} title="向上（W）" className="h-11 w-11 rounded border border-slate-300 bg-white shadow-sm text-slate-800 active:bg-sky-600 active:text-white text-xl touch-manipulation">↑</button>
                <span />
                <button type="button" onClick={() => roamStep('ArrowLeft')} title="向左（A）" className="h-11 w-11 rounded border border-slate-300 bg-white shadow-sm text-slate-800 active:bg-sky-600 active:text-white text-xl touch-manipulation">←</button>
                <span className="flex items-center justify-center text-sky-600 text-xl">{HEADING_ARROW(heading)}</span>
                <button type="button" onClick={() => roamStep('ArrowRight')} title="向右（D）" className="h-11 w-11 rounded border border-slate-300 bg-white shadow-sm text-slate-800 active:bg-sky-600 active:text-white text-xl touch-manipulation">→</button>
                <span />
                <button type="button" onClick={() => roamStep('ArrowDown')} title="向下（S）" className="h-11 w-11 rounded border border-slate-300 bg-white shadow-sm text-slate-800 active:bg-sky-600 active:text-white text-xl touch-manipulation">↓</button>
                <span />
              </div>
              <p className="mt-2 text-xs opacity-60">键盘 W↑ A← S↓ D→（也支持 ↑↓←→）或点屏幕方向键；按实际米数移动，坐标每按一次都会更新，按住可连续移动。所有已标注区域（球道、果岭、发球台、长草区、沙坑、水域、树木、界外）都会挡住脚步，遇障碍停在边缘外。</p>
            </div>
          )}
          {selected && (
            <div className="rounded-lg bg-sky-50 p-3 ring-1 ring-sky-200">
              <h3 className="font-medium mb-1">选中标注</h3>
              <p className="text-sm">{selected.name || LABELS[selected.featureType] || selected.featureType}</p>
              <p className="text-sm opacity-80">类型：{LABELS[selected.featureType] || selected.featureType}</p>
              <p className="text-sm opacity-80">第 {selected.hole} 洞 · {(selected.kind || selected.geomKind) === 'polygon' ? '面状区域' : '线状要素'}</p>
              <button
                onClick={() => setSelected(null)}
                className="mt-2 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 shadow-sm"
              >清除选中</button>
            </div>
          )}
          <div className="rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium">标注分类</h3>
              <button
                onClick={() => { setActiveTypes([...FEATURE_TYPES]); setSelected(null) }}
                className="text-xs rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-700 shadow-sm hover:bg-slate-100"
                title="选中全部标注分类（跨所有洞显示全部标注）"
              >全部显示</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FEATURE_TYPES.map((type: string) => {
                const on = activeTypes.includes(type)
                const color = COLORS[type] || 'rgba(148,163,184,0.8)'
                return (
                  <button
                    key={type}
                    onClick={() => {
                      // 多选：点一次加入所选集合，再点一次取消；选中后只看所选分类（跨所有洞）。
                      setActiveTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]))
                      setSelected(null)
                    }}
                    title={on ? `取消选择${LABELS[type] || type}` : `加上${LABELS[type] || type}（可多选）`}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition border ${on ? 'bg-sky-100 ring-1 ring-sky-400 border-sky-300 text-sky-900' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'}`}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                    {LABELS[type] || type}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs opacity-60">分类可多选：地图只显示所选分类（跨所有洞）。「全部显示」= 选中全部。</p>
            {activeTypes.length > 0 && (
              <button
                onClick={() => { setActiveTypes([]); setSelected(null) }}
                className="mt-2 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 shadow-sm hover:bg-slate-100"
                title="清空分类选择，回到只看当前洞"
              >只看本洞</button>
            )}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium">标注列表</h3>
              <span className="text-xs opacity-60">{activeTypes.length ? `全部洞 · 已选 ${activeTypes.length} 类` : `第 ${hole} 洞`}</span>
            </div>
            {featureGroups.size === 0 ? (
              <p className="text-xs opacity-60">{activeTypes.length ? '所选分类暂无标注。' : '当前洞暂无标注。'}</p>
            ) : (
              <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                {Array.from(featureGroups.keys())
                  .sort((a, b) => {
                    const ia = FEATURE_TYPES.indexOf(a)
                    const ib = FEATURE_TYPES.indexOf(b)
                    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
                  })
                  .map((type) => {
                  const items = featureGroups.get(type)!
                  const color = COLORS[type] || 'rgba(148,163,184,0.8)'
                  return (
                    <div key={type}>
                      <div className="flex items-center gap-1.5 text-xs opacity-80 mb-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                        {LABELS[type] || type}
                        <span className="opacity-60">({items.length})</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        {items.map((g: any, i: number) => {
                          const active = selected && selected.id === g.id
                          return (
                            <button
                              key={g.id}
                              onClick={() => selectFromList(g)}
                              className={`w-full text-left rounded border px-2 py-1 text-xs transition truncate ${active ? 'bg-sky-100 ring-1 ring-sky-400 border-sky-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'}`}
                              title={g.name || `${LABELS[type] || type} ${i + 1}`}
                            >
                              {g.name || `${LABELS[type] || type} ${i + 1}`}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {mode === 'route' && (
            <div className="rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm">
              <h3 className="font-medium mb-2">目标</h3>
              <label className="block text-sm"><input type="radio" name="gtarget" checked={target === 'green'} onChange={() => setTarget('green')} /> 果岭</label>
              <label className="block text-sm"><input type="radio" name="gtarget" checked={target === 'tee'} onChange={() => setTarget('tee')} /> 发球台</label>
              <button onClick={calculateRoute} className="mt-2 w-full rounded bg-emerald-600 px-3 py-1 text-white">计算路线</button>
            </div>
          )}
          {mode === 'shot' && (
            <div className="rounded-lg border border-slate-200 bg-white/90 p-3 shadow-sm">
              <h3 className="font-medium mb-2">击球建议</h3>
              <button onClick={calculateShot} className="w-full rounded bg-emerald-600 px-3 py-1 text-white">生成建议</button>
            </div>
          )}
        </div>
        {/* 地图区：外层 relative 提供定位上下文；地图本身 overflow-hidden，浮层挂外层避免被裁切 */}
        <div className="relative flex-1 min-w-0 min-h-[420px]">
          {/* 数据同步组入口（appId: golf）——与球场地图页保持一致的右上角范式 */}
          <button
            onClick={() => setSyncOpen((v) => !v)}
            className="absolute top-3 right-3 z-[650] px-3 py-1.5 rounded-lg bg-white/95 border border-slate-300 text-slate-700 text-xs shadow"
            title="数据同步组设置"
          >
            同步组
          </button>
          {/* 面板常驻挂载、只切显隐：连接由 config-ui 在挂载时发起，条件渲染会导致「不点开就永不连接」 */}
          <div
            className={`absolute top-14 right-3 z-[650] w-96 max-w-[calc(100%-1.5rem)] rounded-lg bg-white border border-slate-200 text-slate-800 shadow-xl ${syncOpen ? '' : 'hidden'}`}
          >
            <GolfSyncPanel />
          </div>
          <div ref={mapEl} className="absolute inset-0 rounded-lg overflow-hidden bg-slate-200" />
        </div>
      </div>
    </div>
  )
}
