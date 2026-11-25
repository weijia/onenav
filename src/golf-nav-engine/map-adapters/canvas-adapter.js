// 纯 Canvas 矢量适配器：无底图、无依赖，作为任意底图失败时的统一降级。
import { STYLE_COLORS, LINE_STYLES, MARKER_COLORS, parseColor } from './geometry.js';

// 射线法：点是否在多边形内
function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i]; const b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// 点到线段距离，用于线要素命中
function distToSegment(px, py, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export class CanvasAdapter {
  constructor(course, canvas) {
    this.course = course;
    this.canvas = canvas;
    this.polygons = [];
    this.lines = [];
    this.markers = [];
    this.clickHandler = null;
    this.featureClickHandler = null;
    this._hitRegions = [];
    this._selectedId = null;
    this._selectedIds = [];
    this._bound = false;
  }

  create(container, center, zoom) {
    this.container = container;
    // React 应用里 canvas 与 container 是同一个元素，不能隐藏自己
    if (this.canvas && this.canvas !== container) {
      this.canvas.classList.remove('hidden');
      container.classList.add('hidden');
    }
    this._bindClick();
    this.redraw();
    return true;
  }

  _bindClick() {
    if (this._bound) return;
    this._bound = true;
    const rect = () => this.canvas.getBoundingClientRect();
    this.canvas.addEventListener('click', (evt) => {
      const r = rect();
      const x = evt.clientX - r.left;
      const y = evt.clientY - r.top;
      // 先做要素命中：点中标注时只回调要素，不再当作设置当前位置
      const hit = this._hitTest(x, y);
      if (hit) {
        if (this.featureClickHandler) {
          this.featureClickHandler({
            id: hit.id, featureType: hit.featureType, hole: hit.hole,
            featureIndex: hit.featureIndex, styleId: hit.styleId, kind: hit.kind,
            name: hit.name, sourceId: hit.sourceId,
          });
        }
        return;
      }
      const b = this.course.bounds;
      const pad = 20;
      const sx = (r.width - pad * 2) / (b.east - b.west || 1);
      const sy = (r.height - pad * 2) / (b.north - b.south || 1);
      const lat = b.north - (y - pad) / sy;
      const lng = b.west + (x - pad) / sx;
      this.clickHandler && this.clickHandler({ lat, lng });
    });
  }

  _hitTest(x, y) {
    // 倒序遍历：后画的图层在上层，优先命中
    for (let i = this._hitRegions.length - 1; i >= 0; i -= 1) {
      const r = this._hitRegions[i];
      if (r.kind === 'polygon') {
        if (pointInPolygon(x, y, r.points)) return r;
      } else {
        for (let j = 1; j < r.points.length; j += 1) {
          if (distToSegment(x, y, r.points[j - 1], r.points[j]) <= 8) return r;
        }
      }
    }
    return null;
  }

  setSelection(ids) {
    this._selectedIds = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    this._selectedId = this._selectedIds.length ? this._selectedIds[0] : null;
    this.redraw();
  }

  onFeatureClick(handler) { this.featureClickHandler = handler; }

  setPolygons(polys) { this.polygons = polys; this.redraw(); }
  setLines(lines) { this.lines = lines; this.redraw(); }
  setMarkers(markers) { this.markers = markers; this.redraw(); }
  onClick(handler) { this.clickHandler = handler; }

  redraw() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const b = this.course.bounds;
    const pad = 20;
    const sx = (rect.width - pad * 2) / (b.east - b.west || 1);
    const sy = (rect.height - pad * 2) / (b.north - b.south || 1);
    const project = (p) => ({
      x: pad + (p.lng - b.west) * sx,
      y: pad + (b.north - p.lat) * sy,
    });
    this._hitRegions = [];
    this.polygons.forEach((poly) => {
      const pts = poly.paths.map(project);
      if (poly.featureType) {
        this._hitRegions.push({
          id: poly.id, kind: 'polygon', points: pts, featureType: poly.featureType,
          hole: poly.hole, featureIndex: poly.featureIndex, styleId: poly.styleId,
          name: poly.name, sourceId: poly.sourceId,
        });
      }
      const { color, opacity } = parseColor(STYLE_COLORS[poly.styleId] || STYLE_COLORS.fairway);
      ctx.beginPath();
      pts.forEach((q, i) => { if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
      ctx.closePath();
      ctx.globalAlpha = opacity;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (this._selectedIds.includes(poly.id)) {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    });
    this.lines.forEach((line) => {
      const pts = line.paths.map(project);
      if (line.featureType) {
        this._hitRegions.push({
          id: line.id, kind: 'line', points: pts, featureType: line.featureType,
          hole: line.hole, featureIndex: line.featureIndex, styleId: line.styleId,
          name: line.name, sourceId: line.sourceId,
        });
      }
      const style = LINE_STYLES[line.styleId] || LINE_STYLES.center;
      ctx.beginPath();
      pts.forEach((q, i) => { if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
      const isSelected = this._selectedIds.includes(line.id);
      ctx.strokeStyle = isSelected ? '#38bdf8' : style.color;
      ctx.lineWidth = isSelected ? Math.max(4, style.width + 2) : style.width;
      ctx.globalAlpha = style.opacity;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
    this.markers.forEach((m) => {
      const q = project(m.position);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = MARKER_COLORS[m.styleId] || '#378add';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  destroy() { /* canvas 无资源 */ }
}
