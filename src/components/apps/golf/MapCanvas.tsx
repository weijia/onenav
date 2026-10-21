/**
 * 高尔夫球场地图 —— Leaflet 地图画布
 *
 * 采用【命令式】封装（useRef + useEffect 管理 Leaflet 实例），不引入 react-leaflet，
 * 避免 React 19 的版本兼容风险，也让图层生命周期完全可控。
 *
 * 【坐标边界】这是全组件最容易出错的地方，务必注意：
 *   - 本项目存储/业务坐标一律是 [lng, lat] 且为 GCJ-02；
 *   - Leaflet 的 API 用 [lat, lng]，顺序相反；
 *   - 底图 provider 若使用 WGS-84（如 OSM），渲染前要把 GCJ-02 转成 WGS-84，
 *     反向（点击取点、拖拽落点）时要把 WGS-84 转回 GCJ-02 再交给业务层。
 *   因此下面统一用 toDisplay / fromDisplay + ll() 做边界转换，业务代码不直接碰 Leaflet 坐标。
 */

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  AREA_TYPES,
  FACILITY_TYPES,
  facilityColor,
  facilityTitle,
  getBasemap,
  type GolfData,
} from './types'
import {
  distanceMeters,
  formatDistance,
  gcj02ToWgs84,
  wgs84ToGcj02,
  type DistanceUnit,
} from './geo'

export type DrawMode = 'none' | 'marker' | 'polygon' | 'circle' | 'measure'

export interface SelectedRef {
  kind: 'facility' | 'area' | 'line'
  id: string
}

export interface MapCanvasProps {
  data: GolfData
  basemapId: string
  /** 设施类型 → 显隐 */
  visibleFacilityTypes: Record<string, boolean>
  /** 洞号 → 显隐（key 为洞号字符串） */
  visibleHoles: Record<string, boolean>
  /** 区域类型 → 显隐 */
  visibleAreaTypes: Record<string, boolean>
  /** 码数线总开关 */
  showLines: boolean
  manageMode: boolean
  unit: DistanceUnit
  /** 当前绘制模式 */
  drawMode: DrawMode
  /** 绘制中的临时顶点（多边形顶点 / 测距端点），存储坐标 */
  tempPoints: [number, number][]
  selected: SelectedRef | null
  userLocation: { lng: number; lat: number; accuracy: number } | null
  /** 飞行目标；key 变化即触发一次飞行 */
  flyTo: { lng: number; lat: number; zoom?: number; key: number } | null
  onMapClick: (lng: number, lat: number) => void
  onSelect: (kind: 'facility' | 'area' | 'line', id: string) => void
  onMoveFacility: (id: string, lng: number, lat: number) => void
  onMoveArea: (id: string, lng: number, lat: number) => void
  onMoveVertex: (areaId: string, index: number, lng: number, lat: number) => void
  onResizeCircle: (areaId: string, radius: number) => void
  /** 地图实例就绪回调（父组件用它读取视野边界做瓦片预缓存等） */
  onReady: (map: L.Map) => void
}

/** 设施图标：水滴形状 + 类型色 + 白色字符（形状与颜色双重区分，不是纯色圆点） */
function markerSvg(color: string, glyph: string): string {
  return `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
  <path d="M14 1C7.4 1 2 6.4 2 13c0 9 12 21 12 21s12-12 12-21C26 6.4 20.6 1 14 1z"
    fill="${color}" stroke="rgba(255,255,255,0.92)" stroke-width="2"/>
  <text x="14" y="19" text-anchor="middle" font-size="13" font-weight="700"
    fill="#ffffff" font-family="system-ui,-apple-system,sans-serif">${glyph}</text>
</svg>`
}

/** 顶点/控制点小图标（绘制与编辑用） */
function handleSvg(color: string): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="6" fill="#ffffff" stroke="${color}" stroke-width="3"/>
</svg>`
}

export default function MapCanvas(props: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseLayerRef = useRef<L.TileLayer | null>(null)
  const featureGroupRef = useRef<L.LayerGroup | null>(null)
  const tempGroupRef = useRef<L.LayerGroup | null>(null)
  const vertexGroupRef = useRef<L.LayerGroup | null>(null)
  const userGroupRef = useRef<L.LayerGroup | null>(null)

  // 把最新的回调放进 ref，避免 effect 因回调身份变化而反复重建图层
  const handlersRef = useRef(props)
  handlersRef.current = props

  const provider = getBasemap(props.basemapId)
  const crs = provider.crs

  /** 存储坐标(GCJ-02, [lng,lat]) → 该底图可用坐标 */
  const toDisplay = (lng: number, lat: number): [number, number] =>
    crs === 'wgs84' ? gcj02ToWgs84(lng, lat) : [lng, lat]
  /** 底图坐标 → 存储坐标(GCJ-02) */
  const fromDisplay = (lng: number, lat: number): [number, number] =>
    crs === 'wgs84' ? wgs84ToGcj02(lng, lat) : [lng, lat]
  /** 存储坐标 → Leaflet LatLng（注意经纬度顺序相反） */
  const ll = (lng: number, lat: number): L.LatLng => {
    const [dlng, dlat] = toDisplay(lng, lat)
    return L.latLng(dlat, dlng)
  }

  // ── 1. 创建地图（仅一次）──────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const [lng, lat] = handlersRef.current.data.center
    const center = ll(lng, lat)

    // 关闭 Leaflet 自带的缩放与版权控件：
    // 它们所在的 .leaflet-top/.leaflet-bottom 层级是 1000，会盖住我们自己渲染的浮层按钮（z-600）。
    // 缩放按钮改为在 GolfApp 中用普通按钮实现；版权改为本组件自己渲染在低层级。
    const map = L.map(containerRef.current, {
      center,
      zoom: handlersRef.current.data.zoom,
      zoomControl: false,
      attributionControl: false,
    })
    mapRef.current = map

    featureGroupRef.current = L.layerGroup().addTo(map)
    tempGroupRef.current = L.layerGroup().addTo(map)
    vertexGroupRef.current = L.layerGroup().addTo(map)
    userGroupRef.current = L.layerGroup().addTo(map)

    // 地图点击：统一转成存储坐标(GCJ-02)后交给业务层，由父组件按当前绘制模式解释
    map.on('click', (e: L.LeafletMouseEvent) => {
      const [lng2, lat2] = fromDisplay(e.latlng.lng, e.latlng.lat)
      handlersRef.current.onMapClick(lng2, lat2)
    })

    // 容器尺寸变化（侧边栏展开/收起、横竖屏切换）时重算地图尺寸
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(containerRef.current)

    handlersRef.current.onReady(map)

    // 关键修复：地图创建后延迟重算尺寸，修正「初始化时容器尺寸未就绪 → 点击落点与显示位置不一致」的问题。
    // 本质：Leaflet 在创建时就按当时容器尺寸算好像素原点(pixelOrigin)，若此时尺寸不对，之后点击换算出的
    // 经纬度会整体偏移。移动端尤甚——首屏布局未稳定、地址栏收起/展开都会让算出的原点错位。
    const raf1 = requestAnimationFrame(() => map.invalidateSize())
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()))
    const t = window.setTimeout(() => map.invalidateSize(), 250)

    // 移动端：地址栏显隐/旋转会改变「可视视口」，但 fixed 容器 CSS 尺寸不变，ResizeObserver 不触发，
    // 因此单独监听 visualViewport 兜底重算，避免落点偏移焊死在整段会话里。
    const vv = window.visualViewport ?? null
    const onVv = () => map.invalidateSize()
    vv?.addEventListener('resize', onVv)
    vv?.addEventListener('scroll', onVv)

    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      window.clearTimeout(t)
      vv?.removeEventListener('resize', onVv)
      vv?.removeEventListener('scroll', onVv)
      ro.disconnect()
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 2. 底图切换 ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (baseLayerRef.current) {
      map.removeLayer(baseLayerRef.current)
      baseLayerRef.current = null
    }
    const p = getBasemap(handlersRef.current.basemapId)
    baseLayerRef.current = L.tileLayer(p.url, {
      subdomains: p.subdomains,
      maxZoom: p.maxZoom,
      attribution: p.attribution,
    }).addTo(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.basemapId])

  // ── 3. 渲染设施点 / 区域 / 码数线 ────────────────────
  const visSig = JSON.stringify({
    f: props.visibleFacilityTypes,
    h: props.visibleHoles,
    a: props.visibleAreaTypes,
    l: props.showLines,
  })

  useEffect(() => {
    const group = featureGroupRef.current
    const map = mapRef.current
    if (!group || !map) return
    group.clearLayers()

    const { data, visibleFacilityTypes, visibleHoles, visibleAreaTypes, showLines, manageMode, unit } =
      handlersRef.current

    // 3.1 设施点
    for (const f of data.facilities) {
      if (!visibleFacilityTypes[f.type]) continue
      if (f.hole !== undefined && visibleHoles[String(f.hole)] === false) continue
      const color = facilityColor(f)
      const glyph = FACILITY_TYPES[f.type]?.glyph ?? '•'
      const marker = L.marker(ll(f.lng, f.lat), {
        icon: L.divIcon({
          className: 'golf-divicon',
          html: markerSvg(color, glyph),
          iconSize: [28, 36],
          iconAnchor: [14, 36],
        }),
        draggable: manageMode,
        title: facilityTitle(f),
      })
      marker.bindTooltip(facilityTitle(f), { direction: 'top', offset: [0, -34] })
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        handlersRef.current.onSelect('facility', f.id)
      })
      // 管理模式拖拽调整位置
      marker.on('dragend', () => {
        const p = marker.getLatLng()
        const [lng2, lat2] = fromDisplay(p.lng, p.lat)
        handlersRef.current.onMoveFacility(f.id, lng2, lat2)
      })
      marker.addTo(group)
    }

    // 3.2 区域（多边形 / 圆形）
    for (const a of data.areas) {
      if (!visibleAreaTypes[a.type]) continue
      if (a.hole !== undefined && visibleHoles[String(a.hole)] === false) continue
      const meta = AREA_TYPES[a.type]
      if (!meta) continue
      const style: L.PathOptions = {
        color: meta.color,
        fillColor: meta.fillColor,
        fillOpacity: meta.fillOpacity,
        weight: 2,
        dashArray: meta.dashArray,
      }
      let layer: L.Path
      if (a.kind === 'circle' && a.center && a.radius) {
        layer = L.circle(ll(a.center[0], a.center[1]), { ...style, radius: a.radius })
      } else if (a.kind === 'polygon' && a.path && a.path.length >= 2) {
        layer = L.polygon(
          a.path.map(([lng2, lat2]) => ll(lng2, lat2)),
          style,
        )
      } else {
        continue
      }
      layer.bindTooltip(a.name || meta.label, { sticky: true })
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        handlersRef.current.onSelect('area', a.id)
      })
      layer.addTo(group)
    }

    // 3.3 码数线
    if (showLines) {
      for (const line of data.lines) {
        if (line.hole !== undefined && visibleHoles[String(line.hole)] === false) continue
        const meters = distanceMeters(line.from, line.to)
        const text = line.label || formatDistance(meters, unit)
        const poly = L.polyline([ll(line.from[0], line.from[1]), ll(line.to[0], line.to[1])], {
          color: '#f97316',
          weight: 3,
          dashArray: '8 4',
        })
        poly.bindTooltip(
          `<span style="background:rgba(0,0,0,.7);color:#fff;padding:2px 6px;border-radius:6px;font-size:12px">${text}</span>`,
          { permanent: true, direction: 'center', className: 'golf-line-tip' },
        )
        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          handlersRef.current.onSelect('line', line.id)
        })
        poly.addTo(group)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.data.facilities,
    props.data.areas,
    props.data.lines,
    visSig,
    props.manageMode,
    props.unit,
    props.basemapId,
  ])

  // ── 4. 绘制中的临时预览（多边形轮廓 / 测距线）─────────
  const tempSig = JSON.stringify(props.tempPoints)

  useEffect(() => {
    const group = tempGroupRef.current
    if (!group) return
    group.clearLayers()
    const pts = handlersRef.current.tempPoints
    if (pts.length === 0) return
    const mode = handlersRef.current.drawMode
    const latlngs = pts.map(([lng2, lat2]) => ll(lng2, lat2))

    // 顶点小圆点
    latlngs.forEach((p, i) => {
      L.marker(p, {
        icon: L.divIcon({
          className: 'golf-divicon',
          html: handleSvg('#f97316'),
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        interactive: false,
      }).addTo(group)
      if (i > 0 && mode === 'polygon') {
        // 顶点序号，便于知道画到第几个点
        L.marker(p, {
          icon: L.divIcon({
            className: 'golf-divicon',
            html: `<span style="color:#fff;font-size:11px;font-weight:700">${i + 1}</span>`,
            iconSize: [16, 16],
            iconAnchor: [-6, 10],
          }),
          interactive: false,
        }).addTo(group)
      }
    })

    if (mode === 'polygon') {
      // 多边形：连线 + 回到起点的闭合虚线
      if (latlngs.length >= 2) {
        L.polyline(latlngs, { color: '#f97316', weight: 2, dashArray: '5 5' }).addTo(group)
      }
      if (latlngs.length >= 3) {
        L.polygon(latlngs, { color: '#f97316', weight: 1, fillOpacity: 0.12 }).addTo(group)
      }
    } else if (mode === 'measure' && latlngs.length >= 2) {
      const meters = distanceMeters(pts[pts.length - 2], pts[pts.length - 1])
      L.polyline(latlngs, { color: '#ef4444', weight: 3 }).addTo(group)
      L.marker(latlngs[latlngs.length - 1], {
        icon: L.divIcon({
          className: 'golf-divicon',
          html: `<span style="background:rgba(0,0,0,.75);color:#fff;padding:2px 6px;border-radius:6px;font-size:12px;white-space:nowrap">${formatDistance(
            meters,
            handlersRef.current.unit,
          )}</span>`,
          iconSize: [80, 20],
          iconAnchor: [-8, 10],
        }),
        interactive: false,
      }).addTo(group)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempSig, props.drawMode, props.unit, props.basemapId])

  // ── 5. 选中区域的顶点编辑手柄（仅管理模式）────────────
  useEffect(() => {
    const group = vertexGroupRef.current
    if (!group) return
    group.clearLayers()
    const { selected, manageMode, data } = handlersRef.current
    if (!selected || selected.kind !== 'area' || !manageMode) return
    const area = data.areas.find((a) => a.id === selected.id)
    if (!area) return
    const meta = AREA_TYPES[area.type]
    const handleColor = meta?.color ?? '#2563eb'

    if (area.kind === 'polygon' && area.path) {
      // 每个顶点一个可拖拽手柄
      area.path.forEach(([lng2, lat2], index) => {
        const h = L.marker(ll(lng2, lat2), {
          icon: L.divIcon({
            className: 'golf-divicon',
            html: handleSvg(handleColor),
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          draggable: true,
        })
        h.on('dragend', () => {
          const p = h.getLatLng()
          const [nlng, nlat] = fromDisplay(p.lng, p.lat)
          handlersRef.current.onMoveVertex(area.id, index, nlng, nlat)
        })
        h.addTo(group)
      })
    } else if (area.kind === 'circle' && area.center && area.radius) {
      // 圆心手柄：拖动可整体移动圆
      const centerHandle = L.marker(ll(area.center[0], area.center[1]), {
        icon: L.divIcon({
          className: 'golf-divicon',
          html: handleSvg(handleColor),
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        draggable: true,
      })
      centerHandle.on('dragend', () => {
        const p = centerHandle.getLatLng()
        const [nlng, nlat] = fromDisplay(p.lng, p.lat)
        handlersRef.current.onMoveArea(area.id, nlng, nlat)
      })
      centerHandle.addTo(group)

      // 边缘手柄：拖动改变半径（半径 = 圆心到手柄的实际距离）
      const dLng = area.radius / (111320 * Math.cos((area.center[1] * Math.PI) / 180))
      const edgeHandle = L.marker(ll(area.center[0] + dLng, area.center[1]), {
        icon: L.divIcon({
          className: 'golf-divicon',
          html: handleSvg('#ef4444'),
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        draggable: true,
      })
      edgeHandle.on('dragend', () => {
        const p = edgeHandle.getLatLng()
        const [elng, elat] = fromDisplay(p.lng, p.lat)
        const r = distanceMeters(area.center as [number, number], [elng, elat])
        handlersRef.current.onResizeCircle(area.id, Math.max(5, r))
      })
      edgeHandle.addTo(group)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selected?.id, props.selected?.kind, props.manageMode, props.data.areas, props.basemapId])

  // ── 6. GPS 用户位置 ──────────────────────────────────
  useEffect(() => {
    const group = userGroupRef.current
    if (!group) return
    group.clearLayers()
    const u = handlersRef.current.userLocation
    if (!u) return
    const [dlng, dlat] = toDisplay(u.lng, u.lat)
    // 精度圈（GPS 信号强弱）
    L.circle(L.latLng(dlat, dlng), {
      radius: u.accuracy,
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.15,
      weight: 1,
    }).addTo(group)
    // 位置点
    L.circleMarker(L.latLng(dlat, dlng), {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#3b82f6',
      fillOpacity: 1,
    }).addTo(group)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userLocation, props.basemapId])

  // ── 7. 飞行定位（搜索结果 / 洞切换）───────────────────
  useEffect(() => {
    const map = mapRef.current
    const target = props.flyTo
    if (!map || !target) return
    const [dlng, dlat] = toDisplay(target.lng, target.lat)
    map.flyTo(L.latLng(dlat, dlng), target.zoom ?? Math.max(map.getZoom(), 16), { duration: 0.6 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.flyTo?.key])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {/*
        版权信息：Leaflet 自带 attribution 控件层级为 1000 会压住浮层按钮，
        所以这里自己渲染，并刻意放在低层级（z-[400]）与底部，不与任何操作按钮争位。
      */}
      <div className="absolute bottom-0 right-1 z-[400] pointer-events-none rounded bg-black/35 px-1.5 py-[1px] text-[10px] leading-4 text-white/60">
        {getBasemap(props.basemapId).attribution}
      </div>
    </div>
  )
}
