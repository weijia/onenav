// 纯 Canvas 矢量适配器：无底图、无依赖，作为任意底图失败时的统一降级。
import { STYLE_COLORS, LINE_STYLES, MARKER_COLORS, parseColor } from './geometry.js';

export class CanvasAdapter {
  constructor(course, canvas) {
    this.course = course;
    this.canvas = canvas;
    this.polygons = [];
    this.lines = [];
    this.markers = [];
    this.clickHandler = null;
    this._bound = false;
  }

  create(container, center, zoom) {
    this.container = container;
    this.canvas.classList.remove('hidden');
    this.container.classList.add('hidden');
    this._bindClick();
    this.redraw();
    return true;
  }

  _bindClick() {
    if (this._bound) return;
    this._bound = true;
    const b = this.course.bounds;
    const rect = () => this.canvas.getBoundingClientRect();
    this.canvas.addEventListener('click', (evt) => {
      const r = rect();
      const pad = 20;
      const sx = (r.width - pad * 2) / (b.east - b.west || 1);
      const sy = (r.height - pad * 2) / (b.north - b.south || 1);
      const lat = b.north - (evt.clientY - r.top - pad) / sy;
      const lng = b.west + (evt.clientX - r.left - pad) / sx;
      this.clickHandler && this.clickHandler({ lat, lng });
    });
  }

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
    this.polygons.forEach((poly) => {
      const { color, opacity } = parseColor(STYLE_COLORS[poly.styleId] || STYLE_COLORS.fairway);
      ctx.beginPath();
      poly.paths.forEach((pt, i) => {
        const q = project(pt);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.closePath();
      ctx.globalAlpha = opacity;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    this.lines.forEach((line) => {
      const style = LINE_STYLES[line.styleId] || LINE_STYLES.center;
      ctx.beginPath();
      line.paths.forEach((pt, i) => {
        const q = project(pt);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
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
