// 地图呈现层：委托给可切换的地图适配器（腾讯 / 高德 / canvas 降级）。
// 对外 API 保持不变：init / showRoute / clearRoute / showMarkers / enableFallback / onMapClick。
import { buildCourseGeometry, toBusinessPoint } from './map-adapters/geometry.js';
import { createAdapter, sdkReady } from './map-adapters/index.js';

export class MapView {
  constructor(containerId, fallbackCanvasId, options = {}) {
    this.container = document.getElementById(containerId);
    this.canvas = document.getElementById(fallbackCanvasId);
    this.provider = options.provider || 'tencent';
    this.leaflet = options.leaflet || null;
    this.adapter = null;
    this.ready = false;
    this.fallback = false;
    this.course = null;
    this.lastRoute = null;
    this.lastMarkers = [];
    this.geom = { polygons: [], lines: [] };
    this.noticeEl = options.noticeId ? document.getElementById(options.noticeId) : document.getElementById('mapNotice');
  }

  get map() {
    return this.adapter ? this.adapter.map : null;
  }

  _centerOf(course) {
    const b = course.bounds;
    return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
  }

  init(course, providerOverride) {
    this.course = course;
    this.geom = buildCourseGeometry(course);
    const provider = providerOverride || this.provider;
    if (!sdkReady(provider, { TMap: window.TMap, L: this.leaflet || window.L })) {
      this.enableFallback(`${provider === 'tencent' ? '腾讯地图' : '高德地图'} SDK 未加载，已切换为矢量示意图。`);
      return false;
    }
    try {
      const adapter = createAdapter(provider, {
        region: course.region,
        L: this.leaflet || window.L,
        course,
        canvas: this.canvas,
      });
      const ok = adapter.create(this.container, this._centerOf(course), 16);
      if (!ok) throw new Error('适配器初始化返回失败');
      this.adapter = adapter;
      this.provider = provider;
      this.ready = true;
      this.fallback = provider === 'canvas';
      if (this.noticeEl && !this.fallback) {
        this.noticeEl.classList.add('hidden');
      }
      this.adapter.setPolygons(this.geom.polygons);
      this.adapter.setLines(this.geom.lines);
      // 补画此前缓存的路线与标记（定位/交互可能早于地图就绪）
      if (this.lastRoute) this.showRoute(this.lastRoute, course);
      if (this.lastMarkers.length) this.showMarkers(this.lastMarkers, course);
      return true;
    } catch (err) {
      const msg = /sandbox|localStorage|SecurityError/i.test(err && err.message)
        ? '当前为受限预览环境，已自动切换为矢量示意图（不显示底图）。'
        : `地图初始化失败：${err.message}（已切换为矢量示意图）`;
      this.enableFallback(msg);
      return false;
    }
  }

  // 运行时切换底图：保留当前路线/标记，重新建图
  switchProvider(provider, course) {
    const c = course || this.course;
    if (!c) return false;
    const route = this.lastRoute;
    const markers = this.lastMarkers;
    this.lastRoute = null;
    this.lastMarkers = [];
    try { this.adapter && this.adapter.destroy(); } catch (e) { /* ignore */ }
    this.adapter = null;
    this.ready = false;
    this.fallback = false;
    if (this.canvas) this.canvas.classList.add('hidden');
    if (this.container) this.container.classList.remove('hidden');
    const ok = this.init(c, provider);
    if (ok) {
      if (route) this.showRoute(route, c);
      if (markers.length) this.showMarkers(markers, c);
    }
    return ok;
  }

  showRoute(points, course) {
    this.lastRoute = points;
    if (!this.ready || !this.adapter) { this.enableFallback('地图不可用，已切换为矢量示意图。'); return; }
    const route = [{
      id: 'active-route', styleId: 'route',
      paths: points.map(toBusinessPoint),
    }];
    this.adapter.setLines([...this.geom.lines.filter((g) => g.styleId !== 'route'), ...route]);
  }

  clearRoute() {
    this.lastRoute = null;
    if (!this.ready || !this.adapter) return;
    this.adapter.setLines(this.geom.lines);
  }

  showMarkers(markers, course) {
    this.lastMarkers = markers;
    if (!this.ready || !this.adapter) return;
    this.adapter.setMarkers(markers.map((m, i) => ({
      id: m.kind || `m${i}`,
      styleId: MARKER_KIND_TO_STYLE[m.kind] || m.kind || 'landing',
      position: toBusinessPoint(m.position),
    })));
  }

  onMapClick(handler) {
    this._externalClick = handler;
    if (this.adapter) {
      this.adapter.onClick((p) => {
        if (this._externalClick) this._externalClick(p);
      });
    }
  }

  enableFallback(message) {
    if (this.fallback && this.adapter) return;
    try { this.adapter && this.adapter.destroy(); } catch (e) { /* ignore */ }
    this.adapter = null;
    this.ready = false;
    this.fallback = true;
    if (this.noticeEl) {
      this.noticeEl.textContent = message;
      this.noticeEl.classList.remove('hidden');
    }
    if (!this.course) return;
    const adapter = createAdapter('canvas', { course: this.course, canvas: this.canvas });
    this.adapter = adapter;
    adapter.create(this.container, this._centerOf(this.course), 16);
    adapter.onClick((p) => { if (this._externalClick) this._externalClick(p); });
    adapter.setPolygons(this.geom.polygons);
    adapter.setLines([...this.geom.lines, ...(this.lastRoute ? [{ id: 'active-route', styleId: 'route', paths: this.lastRoute.map(toBusinessPoint) }] : [])]);
    adapter.setMarkers(this.lastMarkers.map((m, i) => ({
      id: m.kind || `m${i}`,
      styleId: MARKER_KIND_TO_STYLE[m.kind] || m.kind || 'landing',
      position: toBusinessPoint(m.position),
    })));
  }

  destroy() {
    try { this.adapter && this.adapter.destroy(); } catch (e) { /* ignore */ }
    this.adapter = null;
    this.ready = false;
  }
}

const MARKER_KIND_TO_STYLE = {
  me: 'me',
  target: 'target',
  landing: 'landing',
};
