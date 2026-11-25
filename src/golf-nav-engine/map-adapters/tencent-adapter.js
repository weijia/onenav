// 腾讯地图 GL JS 适配器。SDK 由宿主页面加载后挂在 window.TMap 上。
import { toDisplay, fromDisplay } from '../data/coordinates.js';
import { STYLE_COLORS, LINE_STYLES, MARKER_COLORS } from './geometry.js';

const markerSvg = (color, heading) => {
  // 带朝向时叠加一个指北三角并整体旋转；heading 0=北，顺时针为正。
  const arrow = Number.isFinite(heading)
    ? `<g transform="rotate(${heading} 12 12)"><path d="M12 2 L17 11 L7 11 Z" fill="#ffffff" stroke="${color}" stroke-width="0.8"/></g>`
    : '';
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="${color}" stroke="#ffffff" stroke-width="2"/>${arrow}</svg>`,
  )}`;
};

export class TencentAdapter {
  constructor(region) {
    this.region = region;
    this.map = null;
    this.layers = {};
    this.clickHandler = null;
    this.featureClickHandler = null;
    this._baseGeoms = {};
    this._headingStyles = new Set();
    this._selectedId = null;
    this._suppressMapClickUntil = 0;
  }

  toDisplayPoint(p) {
    const [lat, lng] = toDisplay(p.lat, p.lng, this.region, 'WGS-84');
    return new window.TMap.LatLng(lat, lng);
  }

  create(container, center, zoom) {
    this.container = container;
    const TMap = window.TMap;
    this.map = new TMap.Map(this.container, {
      center: this.toDisplayPoint(center),
      zoom: zoom || 16,
    });
    const polygonStyles = {};
    Object.entries(STYLE_COLORS).forEach(([type, color]) => {
      if (type === 'tree' || type === 'cartPath') return;
      polygonStyles[type] = new TMap.PolygonStyle({
        color, borderColor: 'rgba(0,0,0,0.12)', borderWidth: 1,
      });
    });
    this.layers.polygons = new TMap.MultiPolygon({ map: this.map, styles: polygonStyles, geometries: [] });
    this.layers.lines = new TMap.MultiPolyline({
      map: this.map,
      styles: {
        center: new TMap.PolylineStyle({ color: LINE_STYLES.center.color, width: LINE_STYLES.center.width }),
        cart: new TMap.PolylineStyle({ color: '#ffffff', width: 3, borderWidth: 1, borderColor: '#999999' }),
        route: new TMap.PolylineStyle({ color: LINE_STYLES.route.color, width: 6, borderWidth: 1, borderColor: '#ffffff' }),
      },
      geometries: [],
    });
    this.layers.markers = new TMap.MultiMarker({
      map: this.map,
      styles: {
        me: new TMap.MarkerStyle({ width: 24, height: 24, anchor: { x: 12, y: 12 }, src: markerSvg(MARKER_COLORS.me) }),
        target: new TMap.MarkerStyle({ width: 24, height: 24, anchor: { x: 12, y: 12 }, src: markerSvg(MARKER_COLORS.target) }),
        landing: new TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 }, src: markerSvg(MARKER_COLORS.landing) }),
      },
      geometries: [],
    });
    this.layers.polygons.on('click', (evt) => this._onGeomClick(evt, 'polygon'));
    this.layers.lines.on('click', (evt) => this._onGeomClick(evt, 'line'));
    // 高亮层最后创建，盖在普通图层之上
    this.layers.selectionPolygons = new TMap.MultiPolygon({
      map: this.map,
      styles: {
        selection: new TMap.PolygonStyle({
          color: 'rgba(56,189,248,0.35)', borderColor: '#38bdf8', borderWidth: 4,
        }),
      },
      geometries: [],
    });
    this.layers.selectionLines = new TMap.MultiPolyline({
      map: this.map,
      styles: {
        selection: new TMap.PolylineStyle({ color: '#38bdf8', width: 6, borderWidth: 1, borderColor: '#ffffff' }),
      },
      geometries: [],
    });
    return true;
  }

  setPolygons(polys) {
    Object.keys(this._baseGeoms).forEach((k) => { if (this._baseGeoms[k].kind === 'polygon') delete this._baseGeoms[k]; });
    polys.forEach((p) => {
      if (p.featureType) this._baseGeoms[p.id] = { geom: p, kind: 'polygon', featureType: p.featureType, hole: p.hole, featureIndex: p.featureIndex, styleId: p.styleId };
    });
    this.layers.polygons.setGeometries(polys.map((p) => ({
      id: p.id, styleId: p.styleId, paths: p.paths.map((pt) => this.toDisplayPoint(pt)),
    })));
    this._refreshSelection();
  }

  setLines(lines) {
    Object.keys(this._baseGeoms).forEach((k) => { if (this._baseGeoms[k].kind === 'line') delete this._baseGeoms[k]; });
    lines.forEach((l) => {
      if (l.featureType) this._baseGeoms[l.id] = { geom: l, kind: 'line', featureType: l.featureType, hole: l.hole, featureIndex: l.featureIndex, styleId: l.styleId };
    });
    this.layers.lines.setGeometries(lines.map((l) => ({
      id: l.id, styleId: l.styleId, paths: l.paths.map((pt) => this.toDisplayPoint(pt)),
    })));
    this._refreshSelection();
  }

  setMarkers(markers) {
    const TMap = window.TMap;
    const geoms = markers.map((m, i) => {
      const baseStyleId = MARKER_COLORS[m.styleId] ? m.styleId : 'landing';
      const hasHeading = m.styleId === 'me' && Number.isFinite(m.heading);
      // 朝向标记按角度动态注册样式（腾讯 style 是创建时静态集合，不能每帧改 src）
      const styleId = hasHeading ? `me-h${Math.round((m.heading % 360 + 360) % 360)}` : baseStyleId;
      if (hasHeading && !this._headingStyles.has(styleId)) {
        this.layers.markers.setStyles({
          [styleId]: new TMap.MarkerStyle({
            width: 28, height: 28, anchor: { x: 14, y: 14 }, src: markerSvg(MARKER_COLORS.me, m.heading),
          }),
        });
        this._headingStyles.add(styleId);
      }
      return {
        id: `${m.id || m.kind || 'm'}-${i}`,
        styleId,
        position: this.toDisplayPoint(m.position),
      };
    });
    this.layers.markers.setGeometries(geoms);
  }

  onClick(handler) {
    this.clickHandler = handler;
    // 每次 init 后只绑一次，避免重复
    if (this._boundMap === this.map) return;
    this._boundMap = this.map;
    this.map.on('click', (evt) => {
      if (Date.now() < this._suppressMapClickUntil) return;
      const lat = evt.latLng.getLat();
      const lng = evt.latLng.getLng();
      const [bLat, bLng] = fromDisplay(lat, lng, this.region);
      this.clickHandler && this.clickHandler({ lat: bLat, lng: bLng });
    });
  }

  _onGeomClick(evt, kind) {
    const g = evt && evt.geometry;
    if (!g || !this._baseGeoms[g.id]) return;
    this._suppressMapClickUntil = Date.now() + 100;
    const meta = this._baseGeoms[g.id];
    if (this.featureClickHandler) {
      this.featureClickHandler({ id: g.id, ...meta, kind });
    }
  }

  onFeatureClick(handler) { this.featureClickHandler = handler; }

  setSelection(ids) {
    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    this._selectedIds = list;
    this._selectedId = list.length ? list[0] : null;
    this._refreshSelection();
  }

  _refreshSelection() {
    if (!this.layers.selectionPolygons || !this.layers.selectionLines) return;
    const ids = this._selectedIds || (this._selectedId ? [this._selectedId] : []);
    const polyGeoms = [];
    const lineGeoms = [];
    ids.forEach((id) => {
      const cur = this._baseGeoms[id];
      if (!cur) return;
      const paths = cur.geom.paths.map((pt) => this.toDisplayPoint(pt));
      const g = { id: `selection-${id}`, styleId: 'selection', paths };
      if (cur.kind === 'polygon') polyGeoms.push(g);
      else lineGeoms.push(g);
    });
    this.layers.selectionPolygons.setGeometries(polyGeoms);
    this.layers.selectionLines.setGeometries(lineGeoms);
  }

  destroy() {
    try { this.map && this.map.destroy(); } catch (e) { /* ignore */ }
    this.map = null;
    this.layers = {};
    this._baseGeoms = {};
    this._headingStyles = new Set();
    this._selectedId = null;
    this._suppressMapClickUntil = 0;
  }
}
