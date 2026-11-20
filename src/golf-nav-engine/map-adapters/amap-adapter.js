// 高德地图适配器：基于 Leaflet + 高德公开矢量瓦片（免 key，国内合规底图）。
// Leaflet 实例通过构造参数注入（原生项目传 window.L，Vite 项目 import L from 'leaflet'），
// 使本适配器不依赖任何打包工具或全局环境。
import { toDisplay, fromDisplay } from '../data/coordinates.js';
import { STYLE_COLORS, LINE_STYLES, MARKER_COLORS, parseColor } from './geometry.js';

const AMAP_TILE = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';

export class AmapAdapter {
  constructor(region, L) {
    if (!L || !L.map) throw new Error('AmapAdapter 需要注入 Leaflet 实例（L）');
    this.region = region;
    this.L = L;
    this.map = null;
    this.layers = {};
    this.clickHandler = null;
    this.featureClickHandler = null;
    this._hitLayers = {};
    this._selectedId = null;
    this._suppressMapClick = false;
  }

  toDisplayPoint(p) {
    const [lat, lng] = toDisplay(p.lat, p.lng, this.region, 'WGS-84');
    return [lat, lng];
  }

  create(container, center, zoom) {
    const L = this.L;
    this.container = container;
    this.map = L.map(container, { zoomControl: true }).setView(this.toDisplayPoint(center), zoom || 15);
    L.tileLayer(AMAP_TILE, {
      subdomains: '1234',
      maxZoom: 18,
      attribution: '© 高德地图',
    }).addTo(this.map);
    this.layers.polygons = L.layerGroup().addTo(this.map);
    this.layers.lines = L.layerGroup().addTo(this.map);
    this.layers.markers = L.layerGroup().addTo(this.map);
    this.map.on('click', (evt) => {
      // 点到标注时 layer 的 click 会冒泡到 map，跳过这一次，避免误设当前位置
      if (this._suppressMapClick) { this._suppressMapClick = false; return; }
      const [lat, lng] = fromDisplay(evt.latlng.lat, evt.latlng.lng, this.region);
      this.clickHandler && this.clickHandler({ lat, lng });
    });
    return true;
  }

  setPolygons(polys) {
    const L = this.L;
    this.layers.polygons.clearLayers();
    Object.keys(this._hitLayers).forEach((k) => { if (this._hitLayers[k].kind === 'polygon') delete this._hitLayers[k]; });
    polys.forEach((p) => {
      const { color, opacity } = parseColor(STYLE_COLORS[p.styleId] || STYLE_COLORS.fairway);
      const baseStyle = { color, weight: 1, fillColor: color, fillOpacity: opacity };
      const layer = L.polygon(p.paths.map((pt) => this.toDisplayPoint(pt)), baseStyle).addTo(this.layers.polygons);
      if (p.featureType) this._bindFeatureClick(layer, p, baseStyle, 'polygon');
    });
  }

  setLines(lines) {
    const L = this.L;
    this.layers.lines.clearLayers();
    Object.keys(this._hitLayers).forEach((k) => { if (this._hitLayers[k].kind === 'line') delete this._hitLayers[k]; });
    lines.forEach((l) => {
      const style = LINE_STYLES[l.styleId] || LINE_STYLES.center;
      const baseStyle = { color: style.color, weight: style.width, opacity: style.opacity };
      const layer = L.polyline(l.paths.map((pt) => this.toDisplayPoint(pt)), baseStyle).addTo(this.layers.lines);
      if (l.featureType) this._bindFeatureClick(layer, l, baseStyle, 'line');
    });
  }

  _bindFeatureClick(layer, geom, baseStyle, kind) {
    this._hitLayers[geom.id] = { layer, baseStyle, kind };
    layer.on('click', () => {
      this._suppressMapClick = true;
      if (this.featureClickHandler) {
        this.featureClickHandler({
          id: geom.id,
          featureType: geom.featureType,
          hole: geom.hole,
          featureIndex: geom.featureIndex,
          styleId: geom.styleId,
          name: geom.name,
          sourceId: geom.sourceId,
          kind,
        });
      }
    });
  }

  setSelection(id) {
    const prev = this._selectedId && this._hitLayers[this._selectedId]
      ? this._hitLayers[this._selectedId] : null;
    if (prev) prev.layer.setStyle(prev.baseStyle);
    this._selectedId = id || null;
    const cur = id && this._hitLayers[id] ? this._hitLayers[id] : null;
    if (cur) {
      const highlight = { ...cur.baseStyle, color: '#38bdf8', weight: 4 };
      if (cur.kind === 'polygon') highlight.fillOpacity = Math.max(0.35, cur.baseStyle.fillOpacity || 0.5);
      else highlight.opacity = 1;
      cur.layer.setStyle(highlight);
      if (cur.layer.bringToFront) cur.layer.bringToFront();
    }
  }

  onFeatureClick(handler) { this.featureClickHandler = handler; }

  setMarkers(markers) {
    const L = this.L;
    this.layers.markers.clearLayers();
    markers.forEach((m, i) => {
      const styleId = MARKER_COLORS[m.styleId] ? m.styleId : 'landing';
      const color = MARKER_COLORS[styleId];
      const icon = L.divIcon({
        className: 'gnav-marker',
        html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      L.marker(this.toDisplayPoint(m.position), {
        icon,
        title: m.id || `${styleId}-${i}`,
      }).addTo(this.layers.markers);
    });
  }

  onClick(handler) {
    this.clickHandler = handler;
  }

  destroy() {
    try { this.map && this.map.remove(); } catch (e) { /* ignore */ }
    this.map = null;
    this.layers = {};
    this._hitLayers = {};
    this._selectedId = null;
    this._suppressMapClick = false;
  }
}
