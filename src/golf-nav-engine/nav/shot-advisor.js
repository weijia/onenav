// 击球落点建议：平面避障评分，不含坡度与可见性。
import { cellToLatLng, costAt, isBlocked, worldToCell } from '../geo/passability.js';

export const DISCLAIMER = '仅平面避障建议，不含坡度与可见性判断';

export function candidateLandingPoints(grid, targetCell, options = {}) {
  const radii = options.radiiMeters || [10, 20, 30, 40];
  const sectors = options.sectors || 24;
  const out = [];
  radii.forEach((radiusMeters) => {
    const radiusCells = Math.max(1, Math.round(radiusMeters / grid.resolution));
    for (let i = 0; i < sectors; i += 1) {
      const angle = (i / sectors) * Math.PI * 2;
      const col = Math.round(targetCell.col + radiusCells * Math.cos(angle));
      const row = Math.round(targetCell.row + radiusCells * Math.sin(angle));
      if (isBlocked(grid, col, row)) continue;
      out.push({ col, row });
    }
  });
  // 果岭中心本身也是候选
  if (!isBlocked(grid, targetCell.col, targetCell.row)) out.push({ col: targetCell.col, row: targetCell.row });
  return out;
}

function distanceToNearestBlocked(grid, col, row, maxCells = 12) {
  for (let r = 1; r <= maxCells; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isBlocked(grid, col + dx, row + dy)) return r;
      }
    }
  }
  return maxCells + 1;
}

export function scoreCandidate(grid, candidate) {
  const terrain = costAt(grid, candidate.col, candidate.row, 'walk');
  if (!Number.isFinite(terrain)) return Infinity;
  const clearance = distanceToNearestBlocked(grid, candidate.col, candidate.row);
  const risk = 10 / (clearance + 1) + (terrain - 1) * 0.35;
  return Number(risk.toFixed(4));
}

export function adviseShot(grid, currentPosition, targetPosition, options = {}) {
  const from = worldToCell(grid, currentPosition);
  const target = worldToCell(grid, targetPosition);
  if (isBlocked(grid, from.col, from.row)) {
    return {
      ok: false,
      reason: '当前位置不适合击球',
      candidates: [], recommended: null, conservative: null, disclaimer: DISCLAIMER,
    };
  }
  const candidates = candidateLandingPoints(grid, target, options)
    .map((c) => ({ ...c, risk: scoreCandidate(grid, c) }))
    .filter((c) => Number.isFinite(c.risk))
    .map((c) => ({ ...c, latLng: cellToLatLng(grid, c.col, c.row) }));

  if (candidates.length === 0) {
    return {
      ok: false, reason: '目标周围无可用落点',
      candidates: [], recommended: null, conservative: null, disclaimer: DISCLAIMER,
    };
  }
  candidates.sort((a, b) => a.risk - b.risk);
  const allBlockedHigh = candidates.every((c) => c.risk >= 6);
  const recommended = candidates[0];
  const nearOrigin = candidates.filter((c) => {
    const d = Math.hypot(c.col - from.col, c.row - from.row) * grid.resolution;
    return d <= (options.conservativeMaxMeters || 120);
  });
  const conservative = nearOrigin.length > 0 ? nearOrigin[0] : recommended;
  return {
    ok: true,
    candidates,
    recommended: { ...recommended, kind: allBlockedHigh ? '保守落点' : '推荐落点' },
    conservative: { ...conservative, kind: '保守落点' },
    allBlockedHigh,
    disclaimer: DISCLAIMER,
  };
}
