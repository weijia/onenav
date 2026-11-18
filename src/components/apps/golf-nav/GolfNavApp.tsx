import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { loadCourse } from '@/golf-nav-engine/data/course-schema.js'
import { normalizePoint } from '@/golf-nav-engine/data/coordinates.js'
import { buildGrid, worldToCell, cellToLatLng, snapToPassable } from '@/golf-nav-engine/geo/passability.js'
import { latLngDistance } from '@/golf-nav-engine/geo/geometry.js'
import { findPath } from '@/golf-nav-engine/nav/astar.js'
import { adviseShot } from '@/golf-nav-engine/nav/shot-advisor.js'
import { createAdapter, sdkReady } from '@/golf-nav-engine/map-adapters/index.js'
import { buildCourseGeometry, toBusinessPoint } from '@/golf-nav-engine/map-adapters/geometry.js'
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
  const [hole, setHole] = useState(1)
  const [target, setTarget] = useState<'tee' | 'green'>('green')
  const [position, setPosition] = useState<Point | null>(null)
  const [result, setResult] = useState('点击「定位」或地图设置当前位置，再生成路线。')
  const [notice, setNotice] = useState('')

  const currentHole = useMemo(
    () => course.holes.find((h: any) => h.number === hole) || course.holes[0],
    [course, hole],
  )

  const center = useMemo<Point>(() => {
    const b = course.bounds
    return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 }
  }, [course])

  const centerOn = useCallback((p: Point) => {
    const a = adapterRef.current
    if (!a || !a.map || !a.toDisplayPoint) return
    try {
      const display = a.toDisplayPoint(p)
      if (provider === 'amap') a.map.setView(display, 16)
      else if (provider === 'tencent') a.map.setCenter(display)
    } catch { /* ignore */ }
  }, [provider])

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
      adapterRef.current = adapter
      adapter.setPolygons(courseGeom.polygons)
      adapter.setLines(courseGeom.lines)
      adapter.onClick((pt: Point) => {
        setPosition(pt)
        setResult('已手动设置位置。')
      })
      setProvider(p)
      setNotice('')
    } catch (e: any) {
      setNotice(`地图初始化失败：${e.message}`)
    }
  }, [course, center, courseGeom])

  useEffect(() => {
    initMap('amap')
    return () => { try { adapterRef.current && adapterRef.current.destroy() } catch { /* ignore */ } }
  }, [])

  const locate = () => {
    if (!navigator.geolocation) {
      setPosition(normalizePoint(currentHole.tee))
      setResult('浏览器不支持定位，已使用本洞发球台作为模拟位置。')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setPosition(p)
        setResult(`定位成功（精度约 ${Math.round(pos.coords.accuracy)} 米）。`)
        centerOn(p)
      },
      () => {
        setPosition(normalizePoint(currentHole.tee))
        setResult('定位不可用，已使用本洞发球台作为模拟位置；可点击地图手动设置。')
      },
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  const ensureGrid = () => {
    const parts = [
      currentHole.tee, currentHole.green, ...currentHole.centerLine,
      ...(currentHole.features || []).flatMap((f: any) => [f.polygon, f.line, f.point].filter(Boolean)),
    ]
    const lats = parts.flatMap((p: any) => Array.isArray(p) ? [p[0]] : [])
    const lngs = parts.flatMap((p: any) => Array.isArray(p) ? [p[1]] : [])
    const bounds = lats.length
      ? { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) }
      : course.bounds
    return buildGrid(course, { resolutionMeters: 2, holeNumbers: [hole], bounds })
  }

  const cellFor = (p: Point) => {
    const g = ensureGrid()
    const c = worldToCell(g, p)
    return snapToPassable(g, c.col, c.row) || c
  }

  const calculateRoute = () => {
    if (!position) { setResult('请先定位或点击地图设置位置。'); return }
    const goal = target === 'tee' ? currentHole.tee : currentHole.green
    const r = findPath(ensureGrid(), cellFor(position), cellFor(goal as Point), { mode: 'walk' })
    const a = adapterRef.current
    if (!r.found) { setResult('当前位置到目标无可行路线。'); return }
    const pts = r.points.map((c: any) => cellToLatLng(ensureGrid(), c.col, c.row))
    if (a) a.setLines([...courseGeom.lines, { id: 'route', styleId: 'route', paths: pts.map(toBusinessPoint) }])
    let dist = 0
    for (let i = 1; i < pts.length; i++) dist += latLngDistance(pts[i - 1], pts[i])
    setResult(`路线已生成\n目标：${target === 'tee' ? '发球台' : '果岭'}\n折线距离约 ${dist.toFixed(0)} 米\n路线点数 ${pts.length}`)
  }

  const calculateShot = () => {
    if (!position) { setResult('请先定位或点击地图设置位置。'); return }
    const r = adviseShot(ensureGrid(), position, currentHole.green)
    if (!r.ok || !r.recommended) { setResult(r.reason || '无法生成建议'); return }
    const a = adapterRef.current
    if (a) a.setMarkers([
      { id: 'me', styleId: 'me', position: toBusinessPoint(position) },
      { id: 'green', styleId: 'target', position: toBusinessPoint(currentHole.green) },
      ...r.candidates.slice(0, 6).map((c: any, i: number) => ({ id: `land${i}`, styleId: 'landing', position: toBusinessPoint(c.latLng) })),
    ])
    setResult(`${r.recommended.kind}\n推荐落点风险分 ${r.recommended.risk}（越低越安全）\n${r.disclaimer || ''}`)
  }

  const changeHole = (n: number) => {
    setHole(n)
    const h = course.holes.find((x: any) => x.number === n) || course.holes[0]
    const a = adapterRef.current
    if (a) { a.setLines(courseGeom.lines); a.setMarkers([]) }
    const tee = normalizePoint(h.tee); const green = normalizePoint(h.green)
    centerOn({ lat: (tee.lat + green.lat) / 2, lng: (tee.lng + green.lng) / 2 })
    setResult(`已切换到第 ${n} 洞。`)
  }

  return (
    <div className="flex flex-col gap-3 p-4 h-full">
      <div className="flex flex-wrap items-center gap-2">
        <select value={provider} onChange={(e) => initMap(e.target.value as Provider)} className="rounded bg-white/10 px-2 py-1">
          {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
        </select>
        <select value={hole} onChange={(e) => changeHole(Number(e.target.value))} className="rounded bg-white/10 px-2 py-1">
          {course.holes.map((h: any) => <option key={h.number} value={h.number}>第 {h.number} 洞 · Par {h.par}</option>)}
        </select>
        <button onClick={locate} className="rounded bg-white/10 px-3 py-1">定位</button>
        <div className="flex rounded overflow-hidden">
          <button onClick={() => setMode('route')} className={`px-3 py-1 ${mode === 'route' ? 'bg-emerald-600' : 'bg-white/10'}`}>场内找路</button>
          <button onClick={() => setMode('shot')} className={`px-3 py-1 ${mode === 'shot' ? 'bg-emerald-600' : 'bg-white/10'}`}>击球决策</button>
        </div>
      </div>

      {notice && <div className="rounded bg-amber-900/40 px-3 py-2 text-sm">{notice}</div>}
      <p className="text-xs opacity-70">
        数据源：{usingShared ? '球场地图共享标注（独立库 golf）' : '内置示例球场（共享数据尚无 tee/green 标注）'}
        {sharedLoading ? ' · 加载中…' : ''}
      </p>

      <div className="flex flex-col md:flex-row gap-3 flex-1 min-h-0">
        <div className="w-full md:w-64 shrink-0 flex flex-col gap-3">
          <div className="rounded-lg bg-white/5 p-3">
            <h3 className="font-medium mb-2">状态</h3>
            <p className="text-sm whitespace-pre-line leading-relaxed">{result}</p>
          </div>
          {mode === 'route' && (
            <div className="rounded-lg bg-white/5 p-3">
              <h3 className="font-medium mb-2">目标</h3>
              <label className="block text-sm"><input type="radio" name="gtarget" checked={target === 'green'} onChange={() => setTarget('green')} /> 果岭</label>
              <label className="block text-sm"><input type="radio" name="gtarget" checked={target === 'tee'} onChange={() => setTarget('tee')} /> 发球台</label>
              <button onClick={calculateRoute} className="mt-2 w-full rounded bg-emerald-600 px-3 py-1">计算路线</button>
            </div>
          )}
          {mode === 'shot' && (
            <div className="rounded-lg bg-white/5 p-3">
              <h3 className="font-medium mb-2">击球建议</h3>
              <button onClick={calculateShot} className="w-full rounded bg-emerald-600 px-3 py-1">生成建议</button>
            </div>
          )}
        </div>
        <div ref={mapEl} className="flex-1 min-h-[420px] rounded-lg overflow-hidden bg-slate-200" />
      </div>

      <GolfSyncPanel />
    </div>
  )
}
