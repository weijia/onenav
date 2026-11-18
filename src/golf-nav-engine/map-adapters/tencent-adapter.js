// 腾讯地图 GL JS 适配器。SDK 由宿主页面加载后挂在 window.TMap 上。
import { toDisplay, fromDisplay } from '../data/coordinates.js';
import { STYLE_COLORS, LINE_STYLES, MARKER_COLORS } from './geometry.js';

const markerSvg = (color) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="${color}" stroke="#ffffff" stroke-width="2"/></svg>`,
)}`;

export class TencentAdapter {
  constructor(region) {
    this.region = region;
    this.map = null;
    this.layers = {};
    this.clickHandler = null;
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
    return true;
  }

  setPolygons(polys) {
    this.layers.polygons.setGeometries(polys.map((p) => ({
      id: p.id, styleId: p.styleId, paths: p.paths.map((pt) => this.toDisplayPoint(pt)),
    })));
  }

  setLines(lines) {
    this.layers.lines.setGeometries(lines.map((l) => ({
      id: l.id, styleId: l.styleId, paths: l.paths.map((pt) => this.toDisplayPoint(pt)),
    })));
  }

  setMarkers(markers) {
    this.layers.markers.setGeometries(markers.map((m, i) => ({
      id: `${m.id || m.kind || 'm'}-${i}`,
      styleId: MARKER_COLORS[m.styleId] ? m.styleId : 'landing',
      position: this.toDisplayPoint(m.position),
    })));
  }

  onClick(handler) {
    this.clickHandler = handler;
    // 每次 init 后只绑一次，避免重复
    if (this._boundMap === this.map) return;
    this._boundMap = this.map;
    this.map.on('click', (evt) => {
      const lat = evt.latLng.getLat();
      const lng = evt.latLng.getLng();
      const [bLat, bLng] = fromDisplay(lat, lng, this.region);
      this.clickHandler && this.clickHandler({ lat: bLat, lng: bLng });
    });
  }

  destroy() {
    try { this.map && this.map.destroy(); } catch (e) { /* ignore */ }
    this.map = null;
    this.layers = {};
  }
}
