import { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react';
import { getStroke } from 'perfect-freehand';
import './canvas.css';
import 'katex/dist/katex.min.css';
import { renderRichToHtml } from './richtext.js';
import { NODE_KINDS, EDGE_KINDS, NODE_STATUSES, FONT_FAMILIES } from './argTypes.js';
import { clampViewport, boxOfStroke, pageOfY } from './pages.js';
import { pdfPlacement, nearestChar, textRange } from './pdf.js';
import { recognizeShape } from './shapeSnap.js';
import PageBg, { AssetImg } from './PageBg.jsx';

export const GRID_SIZE = 20;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
const ZOOM_IN_FACTOR = 1.08;
const ZOOM_OUT_FACTOR = 0.92;

export const ANCHORS = ['top', 'right', 'bottom', 'left'];

/* ================================================================
   Utility: get anchor world position for a node
   ================================================================ */
// Negation widens a node / operator pill by one grid cell to the LEFT: that red
// strip (with a "~" badge in its corner) is the ¬. Geometry treats the strip
// as part of the shape, so the left anchor sits on the strip's edge.
export const NOT_STRIP = 20;

// Pills that follow the curve snap to the nearest quarter turn, so glyphs and
// the ¬ strip never sit at odd angles. Result ∈ {0, 90, 180, -90}.
export function snapAngle(deg) {
  let a = Math.round((deg || 0) / 90) * 90;
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}
// Which LOCAL side of a pill rotated by `deg` faces screen-left — where the ¬
// strip goes, so negation always reads on the left whatever the rotation.
export function notSideFor(deg) {
  switch (snapAngle(deg)) {
    case 180: return { lx: 1, ly: 0 };    // local right
    case 90:  return { lx: 0, ly: 1 };    // local bottom
    case -90: return { lx: 0, ly: -1 };   // local top
    default:  return { lx: -1, ly: 0 };   // local left
  }
}
// Local-frame outline of the ¬ strip (one grid cell) hugging side S of a pill
// of half-size (w, h); closes along the pill edge, which is the divider.
export function notStripPath(S, w, h, d = NOT_STRIP) {
  if (S.lx < 0) return `M ${-w} ${-h} H ${-w - d + h} A ${h} ${h} 0 0 0 ${-w - d + h} ${h} H ${-w} Z`;
  if (S.lx > 0) return `M ${w} ${-h} H ${w + d - h} A ${h} ${h} 0 0 1 ${w + d - h} ${h} H ${w} Z`;
  if (S.ly < 0) return `M ${-w} ${-h} V ${-h - d + h} A ${h} ${h} 0 0 1 ${-w + h} ${-h - d} H ${w - h} A ${h} ${h} 0 0 1 ${w} ${-h - d + h} V ${-h} Z`;
  return `M ${-w} ${h} V ${h + d - h} A ${h} ${h} 0 0 0 ${-w + h} ${h + d} H ${w - h} A ${h} ${h} 0 0 0 ${w} ${h + d - h} V ${h} Z`;
}
export function getAnchorPos(node, anchor, heightMap) {
  const w = node.width || 220;
  const h = node.height || (heightMap && heightMap[node.id]) || 60;
  // The drawn box includes the ¬ cell, so its centre shifts half a cell left.
  const cx = node.x + w / 2 - (node.negated ? NOT_STRIP / 2 : 0);
  switch (anchor) {
    case 'top':    return { x: cx,         y: node.y };
    case 'right':  return { x: node.x + w, y: node.y + h / 2 };
    case 'bottom': return { x: cx,         y: node.y + h };
    case 'left':   return { x: node.x - (node.negated ? NOT_STRIP : 0), y: node.y + h / 2 };
    default:       return { x: node.x + w / 2, y: node.y + h / 2 };
  }
}

/* ================================================================
   Utility: get anchor world position for a region (midpoint of side)
   ================================================================ */
export function getRegionAnchorPos(region, anchor) {
  switch (anchor) {
    case 'top':    return { x: region.x + region.w / 2, y: region.y };
    case 'right':  return { x: region.x + region.w,     y: region.y + region.h / 2 };
    case 'bottom': return { x: region.x + region.w / 2, y: region.y + region.h };
    case 'left':   return { x: region.x,                y: region.y + region.h / 2 };
    default:       return { x: region.x + region.w / 2, y: region.y + region.h / 2 };
  }
}

/* ================================================================
   Utility: cubic bezier path between two anchor endpoints
   ================================================================ */
// fromCtrl / toCtrl are OPTIONAL per-arrow control-point overrides, stored as
// offsets {dx, dy} RELATIVE to the respective endpoint. Relative (not absolute)
// so the handle survives node/region movement: when an endpoint moves, the
// control point moves with it, preserving the curve shape. When absent, the
// control point falls back to the auto tension heuristic keyed off the anchor.
// An anchor is a node side name ('top' | 'right' | 'bottom' | 'left') or, for a
// pill side (pills may be rotated with the curve), an outward normal { nx, ny }.
function anchorNormal(anchor) {
  if (anchor && typeof anchor === 'object') return anchor;
  switch (anchor) {
    case 'right':  return { nx: 1, ny: 0 };
    case 'left':   return { nx: -1, ny: 0 };
    case 'top':    return { nx: 0, ny: -1 };
    case 'bottom': return { nx: 0, ny: 1 };
    default:       return null;
  }
}
// Nearest cardinal side name for an anchor (for axis-aligned routing).
function anchorName(anchor) {
  if (!anchor || typeof anchor !== 'object') return anchor;
  return Math.abs(anchor.nx) >= Math.abs(anchor.ny)
    ? (anchor.nx > 0 ? 'right' : 'left')
    : (anchor.ny > 0 ? 'bottom' : 'top');
}

export function bezierPath(sx, sy, fromAnchor, ex, ey, toAnchor, fromCtrl, toCtrl) {
  const dist = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
  const tension = Math.max(dist * 0.4, 40);

  let cp1x, cp1y;
  if (fromCtrl) {
    cp1x = sx + fromCtrl.dx; cp1y = sy + fromCtrl.dy;
  } else {
    const n = anchorNormal(fromAnchor);
    cp1x = sx + (n ? n.nx * tension : 0); cp1y = sy + (n ? n.ny * tension : 0);
  }

  let cp2x, cp2y;
  if (toCtrl) {
    cp2x = ex + toCtrl.dx; cp2y = ey + toCtrl.dy;
  } else {
    const n = anchorNormal(toAnchor);
    cp2x = ex + (n ? n.nx * tension : 0); cp2y = ey + (n ? n.ny * tension : 0);
  }

  // Midpoint of cubic bezier at t=0.5
  const midX = 0.125 * sx + 0.375 * cp1x + 0.375 * cp2x + 0.125 * ex;
  const midY = 0.125 * sy + 0.375 * cp1y + 0.375 * cp2y + 0.125 * ey;
  // Tangent there (the derivative at t=½), for anything drawn aligned with the curve.
  const midAngle = Math.atan2((cp2y + ey) - (sy + cp1y), (cp2x + ex) - (sx + cp1x)) * 180 / Math.PI;

  return { path: `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${ex} ${ey}`, cp1x, cp1y, cp2x, cp2y, midX, midY, midAngle };
}

/* ================================================================
   Utility: straight-line "path" with the same return shape as bezierPath.
   Control points sit slightly inset from each end so arrowhead direction
   and midpoint-glyph rotation come out correct.
   ================================================================ */
export function straightPath(sx, sy, ex, ey) {
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const off = Math.min(len * 0.3, 40);
  return {
    path: `M ${sx} ${sy} L ${ex} ${ey}`,
    cp1x: sx + ux * off, cp1y: sy + uy * off,
    cp2x: ex - ux * off, cp2y: ey - uy * off,
    midX: (sx + ex) / 2, midY: (sy + ey) / 2,
    midAngle: Math.atan2(dy, dx) * 180 / Math.PI,
  };
}

/* ================================================================
   Utility: orthogonal "elbow" connector (Excalidraw-style), with
   rounded corners. Routes the line along the cardinal axes, exiting
   each endpoint in the direction of its anchor.
   ================================================================ */
function elbowPoints(sx, sy, fromAnchorIn, ex, ey, toAnchorIn) {
  const fromAnchor = anchorName(fromAnchorIn), toAnchor = anchorName(toAnchorIn);
  const fh = fromAnchor === 'left' || fromAnchor === 'right';
  const th = toAnchor === 'left' || toAnchor === 'right';
  if (fh && th) {
    const mx = (sx + ex) / 2;
    return [[sx, sy], [mx, sy], [mx, ey], [ex, ey]];
  }
  if (!fh && !th) {
    const my = (sy + ey) / 2;
    return [[sx, sy], [sx, my], [ex, my], [ex, ey]];
  }
  if (fh && !th) return [[sx, sy], [ex, sy], [ex, ey]];
  return [[sx, sy], [sx, ey], [ex, ey]];
}

function roundedPolyPath(ptsIn, r) {
  // Drop consecutive duplicates so collinear/degenerate corners vanish.
  const pts = ptsIn.filter((p, i) => i === 0 || p[0] !== ptsIn[i - 1][0] || p[1] !== ptsIn[i - 1][1]);
  if (pts.length < 2) return `M ${pts[0]?.[0] || 0} ${pts[0]?.[1] || 0}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
    const v1x = prev[0] - cur[0], v1y = prev[1] - cur[1];
    const v2x = next[0] - cur[0], v2y = next[1] - cur[1];
    const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L ${(cur[0] + (v1x / l1) * rr).toFixed(2)} ${(cur[1] + (v1y / l1) * rr).toFixed(2)}`;
    d += ` Q ${cur[0]} ${cur[1]} ${(cur[0] + (v2x / l2) * rr).toFixed(2)} ${(cur[1] + (v2y / l2) * rr).toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function polyMidpoint(pts) {
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(L); total += L;
  }
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    if (half <= seg[i - 1]) {
      const t = seg[i - 1] ? half / seg[i - 1] : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    half -= seg[i - 1];
  }
  return pts[pts.length - 1];
}

export function elbowPath(sx, sy, fromAnchor, ex, ey, toAnchor) {
  const pts = elbowPoints(sx, sy, fromAnchor, ex, ey, toAnchor);
  const [midX, midY] = polyMidpoint(pts);
  // Orientation at the midpoint: the segment the midpoint lies on.
  let midAngle = 0;
  { let acc = 0; const total = pts.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc + d >= total / 2 || i === pts.length - 1) { midAngle = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI; break; } acc += d; } }
  // cp1/cp2 = neighbours of the endpoints → correct arrowhead orientation.
  return {
    path: roundedPolyPath(pts, 16),
    cp1x: pts[1][0], cp1y: pts[1][1],
    cp2x: pts[pts.length - 2][0], cp2y: pts[pts.length - 2][1],
    midX, midY, midAngle,
  };
}

/* ================================================================
   Utility: arrowhead points at end of curve
   ================================================================ */
// Slender head (long, narrow, slightly notched at the back) — reads like a
// typeset → rather than a fat triangle. `size` is the head length.
export function arrowheadPoints(ex, ey, cp2x, cp2y, size = 12) {
  const dx = ex - cp2x;
  const dy = ey - cp2y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const half = size * 0.3;
  const x1 = ex - ux * size + px * half;
  const y1 = ey - uy * size + py * half;
  const x2 = ex - ux * size - px * half;
  const y2 = ey - uy * size - py * half;
  const nx = ex - ux * size * 0.8;   // back notch
  const ny = ey - uy * size * 0.8;
  return `${ex},${ey} ${x1},${y1} ${nx},${ny} ${x2},${y2}`;
}

/* ================================================================
   Utility: closest anchor on a node to a world point
   ================================================================ */
function closestAnchor(node, wx, wy, heightMap) {
  let best = null;
  let bestDist = Infinity;
  for (const a of ANCHORS) {
    const p = getAnchorPos(node, a, heightMap);
    const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return { anchor: best, dist: Math.sqrt(bestDist) };
}

/* ================================================================
   Utility: snap to grid
   ================================================================ */
function snap(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

// Soft ("magnetic") grid snap: within MAGNET_ZONE of a grid line the value
// sticks to it; further out it eases back to free movement, so there is no
// jump anywhere — at half a cell it meets the neighbouring line's pull.
const MAGNET_ZONE = GRID_SIZE * 0.2;
function magnet(v) {
  const r = snap(v);
  const d = v - r;
  const a = Math.abs(d);
  if (a <= MAGNET_ZONE) return r;
  const half = GRID_SIZE / 2;
  const t = Math.min(1, (a - MAGNET_ZONE) / (half - MAGNET_ZONE));
  return r + Math.sign(d) * half * Math.pow(t, 1.35);
}

/* ================================================================
   Utility: pill bounds (half-width, half-height) for a typed arrow.

   Used to project arrow endpoints to the pill BORDER (not center)
   based on which anchor (top/right/bottom/left) is attached.
   ================================================================ */
// A fresh node is 3×2 grid cells; text-fitting nodes grow up to 15 cells wide, then wrap.
// Single source of truth for every spawn path (click, N, I/J/K/L, drag-to-empty, double-click).
export const NEW_NODE_W = 60, NEW_NODE_H = 40;
const MIN_FIT_WIDTH = NEW_NODE_W, MAX_FIT_WIDTH = 300;
const PILL_TEXT_HALF_W = 17; // pillW=34
const PILL_TEXT_HALF_H = 13; // pillH=26
const PILL_GLYPH_HALF  = 13; // circle r=13
const PILL_WEIGHTED_HALF_W = 26; // widened pill: glyph + editable number
const PILL_WEIGHTED_HALF_H = 13;

/** Arrowhead placement for an arrow: 'none' | 'forward' | 'reverse' | 'both'. */
export function arrowsModeOf(arrow, kindDef) {
  const dirLocked = kindDef && kindDef.render === 'text';
  return dirLocked ? (kindDef.arrows || 'forward')
    : (arrow.direction || (arrow.bidirectional ? 'both' : (kindDef ? (kindDef.arrows || 'forward') : 'forward')));
}

/** The stroke stops at the arrowhead's back notch instead of running under the
 *  head to the tip, so the line visibly meets the head. Bezier paths only. */
export function headedPath(geo, mode, size = 12) {
  const m = geo.path.match(/^M (\S+) (\S+) C (\S+) (\S+), (\S+) (\S+), (\S+) (\S+)$/);
  if (!m) return geo.path;
  let [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = m.slice(1).map(Number);
  const back = size * 0.8;
  const pull = (px, py, cx, cy) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1; return [px - dx / l * back, py - dy / l * back]; };
  if (mode === 'forward' || mode === 'both') [ex, ey] = pull(ex, ey, c2x, c2y);
  if (mode === 'reverse' || mode === 'both') [sx, sy] = pull(sx, sy, c1x, c1y);
  return `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`;
}

export function getPillBounds(arrow, edgeKinds) {
  const kindDef = arrow.kind ? edgeKinds[arrow.kind] : null;
  if (!kindDef) return null;
  if (kindDef.weighted) return { halfW: PILL_WEIGHTED_HALF_W, halfH: PILL_WEIGHTED_HALF_H };
  if (kindDef.render === 'text') return { halfW: PILL_TEXT_HALF_W, halfH: PILL_TEXT_HALF_H };
  return { halfW: PILL_GLYPH_HALF, halfH: PILL_GLYPH_HALF };
}

/* ================================================================
   Utility: resolve arrow endpoint to a world position.

   end is 'from' or 'to'. Endpoint can either be a node-anchor or the
   pill (border) of another typed arrow. The anchor name (top/right/
   bottom/left) tells us which pill side to project to. Pill endpoints
   recurse through the host arrow's geometry.

   Returns { x, y } or null if any reference is missing / cyclic.
   ================================================================ */
export function resolveEndpoint(arrow, end, nodes, arrows, heights, edgeKinds, regions = {}, depth = 0, centerOnly = false) {
  if (depth > 8) return null; // guard against cycles
  const pillId   = end === 'from' ? arrow.fromPillArrowId : arrow.toPillArrowId;
  const nodeId   = end === 'from' ? arrow.fromNodeId      : arrow.toNodeId;
  const regionId = end === 'from' ? arrow.fromRegionId    : arrow.toRegionId;
  const point    = end === 'from' ? arrow.fromPoint       : arrow.toPoint;
  const anchor   = end === 'from' ? arrow.fromAnchor      : arrow.toAnchor;
  // Free-floating endpoint (arrow drawn "from empty to empty"): fixed world point.
  if (point) return { x: point.x, y: point.y, anchor };
  if (pillId) {
    const host = arrows[pillId];
    if (!host) return null;
    const hf = resolveEndpoint(host, 'from', nodes, arrows, heights, edgeKinds, regions, depth + 1);
    const ht = resolveEndpoint(host, 'to',   nodes, arrows, heights, edgeKinds, regions, depth + 1);
    if (!hf || !ht) return null;
    const { midX, midY, midAngle } = bezierPath(hf.x, hf.y, hf.anchor, ht.x, ht.y, ht.anchor, host.fromCtrl, host.toCtrl);
    const b = getPillBounds(host, edgeKinds);
    if (!b || centerOnly) return { x: midX, y: midY, anchor: null };
    // The pill is drawn rotated along its curve for rotateWithFlow kinds.
    const hk = host.kind ? edgeKinds[host.kind] : null;
    const deg = hk && hk.rotateWithFlow ? snapAngle(midAngle) : 0;
    const ang = deg * Math.PI / 180;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    // The side is the one the arrow was attached to (top/right/bottom/left in
    // the pill's own, possibly rotated, frame) — it stays put as things move.
    // Only an arrow with no stored side picks the side facing its other end.
    let lx, ly; // side in the pill's local frame (unit direction)
    const n = typeof anchor === 'string' ? anchorNormal(anchor) : null;
    if (n) { lx = n.nx; ly = n.ny; }
    else {
      const other = resolveEndpoint(arrow, end === 'from' ? 'to' : 'from', nodes, arrows, heights, edgeKinds, regions, depth + 1, true);
      const dx = other ? other.x - midX : 1, dy = other ? other.y - midY : 0;
      const ox = dx * cos + dy * sin, oy = -dx * sin + dy * cos;
      if (Math.abs(ox) * b.halfH >= Math.abs(oy) * b.halfW) { lx = ox >= 0 ? 1 : -1; ly = 0; }
      else { lx = 0; ly = oy >= 0 ? 1 : -1; }
    }
    // A negated operator is one grid cell wider on its screen-left side (the ¬ strip).
    const S = host.negated ? notSideFor(deg) : null;
    const onStrip = S && S.lx === lx && S.ly === ly;
    const px = lx * (b.halfW + (onStrip && lx ? NOT_STRIP : 0)), py = ly * (b.halfH + (onStrip && ly ? NOT_STRIP : 0));
    return {
      x: midX + px * cos - py * sin,
      y: midY + px * sin + py * cos,
      anchor: { nx: lx * cos - ly * sin, ny: lx * sin + ly * cos },
    };
  }
  if (regionId) {
    const r = regions[regionId];
    if (!r) return null;
    return { ...getRegionAnchorPos(r, anchor), anchor };
  }
  const n = nodes[nodeId];
  if (!n) return null;
  return { ...getAnchorPos(n, anchor, heights), anchor };
}

/* ================================================================
   Utility: convert freehand points to smoothed SVG path
   ================================================================ */
function pointsToPath(points) {
  if (!points || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.01 0`; // a dot — still hittable
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const mx = (prev.x + cur.x) / 2;
    const my = (prev.y + cur.y) / 2;
    d += ` Q ${prev.x} ${prev.y}, ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/* ================================================================
   Utility: Excalidraw-style "gel pen" freehand stroke.
   Uses perfect-freehand to build a variable-width outline (pressure
   simulated from speed) and returns a FILLED SVG path string.
   ================================================================ */
// Pen: draw a rough line / rectangle / ellipse and HOLD STILL at the end for
// this long — the stroke snaps to the clean shape (src/shapeSnap.js). A stroke
// that is none of those (handwriting, squiggles) is left exactly as drawn.
const HOLD_SNAP_MS = 450;
const HOLD_STILL_PX = 5; // screen px the pointer may drift and still count as resting
// Pressure of the stylus currently drawing (0–1), or null for mouse / finger.
// Set by the touch adapter around the mouse events it synthesises, so the one
// drawing pipeline (mouse) records real pen pressure.
let activePenPressure = null;
// Sub-pixel client position of the stylus for the mousedown being replayed
// (touch events report whole CSS pixels; pointer events don't).
let activePenPos = null;
// True while a touch-screen contact (finger or stylus) is being replayed as
// mouse events — such strokes get the light "precise" streamline.
let activeTouchInput = false;
const STREAMLINE_PRECISE = 0.2; // pen / touch (Excalidraw's DEFAULT_STROKE_STREAMLINE_PRECISE)
const STREAMLINE_MOUSE = 0.5;
const STREAMLINE_PEN = 0.3; // real-pressure stylus: a little more, with steadyPen()
const SHIFT_LOCK_ANGLE = Math.PI / 12; // 15° steps while Shift is held
// Stored ink is rounded to 1/100 px: invisible, and it keeps a page of
// handwriting from being megabytes of float noise in the file.
const r2 = (v) => Math.round(v * 100) / 100;
function penPoint(x, y) {
  return activePenPressure == null ? { x: r2(x), y: r2(y) } : { x: r2(x), y: r2(y), p: Math.round(activePenPressure * 1000) / 1000 };
}
// End point of a straight line from `a`: Shift locks the direction to 15°
// steps (the pointer is projected onto that ray), Ctrl/Cmd leaves it free,
// otherwise it is magnetised to the grid.
function lineEndPoint(a, x, y, mods) {
  if (mods && mods.lock) {
    const ang = Math.round(Math.atan2(y - a.y, x - a.x) / SHIFT_LOCK_ANGLE) * SHIFT_LOCK_ANGLE;
    const len = (x - a.x) * Math.cos(ang) + (y - a.y) * Math.sin(ang);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }
  if (mods && mods.free) return { x, y };
  return { x: magnet(x), y: magnet(y) };
}
function appendStrokePoint(cs, x, y, mods) {
  if (!cs) return;
  // Shift while drawing: the stroke becomes a straight line from its start.
  if (mods && mods.lock && !cs.shape) { cs.shape = 'line'; cs.points = [cs.points[0]]; }
  if (cs.shape) {
    // Already a shape: a line's free end keeps following the pointer (so it
    // can be aimed); a rectangle / ellipse is final.
    if (cs.shape === 'line') cs.points = [cs.points[0], lineEndPoint(cs.points[0], x, y, mods)];
    return;
  }
  cs.points.push(penPoint(x, y));
}
const modsOf = (e) => ({ lock: !!e.shiftKey, free: !!(e.metaKey || e.ctrlKey) });

// perfect-freehand has distances hard-coded in its own input units: it leaves
// the last 3 units of a stroke unprocessed ("noise at the end of the line") and
// bridges them with a straight segment to the tip. At 1 unit = 1 world px that
// bridge is 3 px — 1/7 of a grid cell, plainly visible trailing the pen once
// zoomed in. So the outline is computed on coordinates scaled up by INK_SCALE
// and scaled back: the bridge shrinks to 3 / INK_SCALE px. (Everything else in
// the library is relative to `size`, which is scaled along.)
const INK_SCALE = 20;
// A touch of stabilisation for stylus strokes — just enough to take the grain
// off: sensor jitter in position (one [1 2 1]/4 pass; the ends stay put) and
// in pressure (5-sample mean — sample-to-sample pressure noise is what makes
// the edge of a stroke look rough). Applied when the outline is built; the
// stored points stay raw.
function steadyPen(points) {
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    let x = p.x, y = p.y;
    if (i > 0 && i < n - 1) {
      x = (points[i - 1].x + 2 * p.x + points[i + 1].x) / 4;
      y = (points[i - 1].y + 2 * p.y + points[i + 1].y) / 4;
    }
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { sum += points[j].p == null ? 0.5 : points[j].p; cnt++; }
    out[i] = { x, y, p: sum / cnt };
  }
  return out;
}
export function gelStrokePath(points, width, shape, streamline, flat) {
  if (!points || points.length === 0) return '';
  const K = INK_SCALE;
  if (shape || flat) {
    // A snapped shape: constant width, no smoothing lag — corners stay corners.
    // A highlighter stroke: constant width too, lightly streamlined.
    const o = getStroke(points.map((p) => [p.x * K, p.y * K]), {
      size: Math.max(0.6, width || 4) * K, thinning: 0, smoothing: 0.5, streamline: shape ? 0 : 0.3, simulatePressure: false, last: true,
    });
    if (!o.length) return '';
    return 'M ' + o.map(([x, y]) => `${(x / K).toFixed(2)} ${(y / K).toFixed(2)}`).join(' L ') + ' Z';
  }
  // Points recorded from a stylus carry real pressure (`p`); everything else
  // gets pressure simulated from speed.
  const real = points[0].p != null;
  const scaled = getStroke(real ? steadyPen(points).map((p) => [p.x * K, p.y * K, p.p]) : points.map((p) => [p.x * K, p.y * K]), {
    // `size` is the brush diameter in px — keep it ~1:1 with the stored
    // width so strokes match the old line weight (no 3× fattening).
    size: Math.max(0.6, width || 4) * K,
    thinning: real ? 0.6 : 0.55,
    smoothing: 0.5,
    // Streamline drags every point toward the previous one. Fine for a mouse;
    // from a pen or a finger it rounds off small handwriting, so those strokes
    // carry a light value (stored per stroke, as Excalidraw does).
    streamline: real ? STREAMLINE_PEN : (streamline || STREAMLINE_MOUSE),
    ...(real ? { easing: (t) => Math.sin((t * Math.PI) / 2) } : {}),
    simulatePressure: !real,
    last: true,
  });
  if (!scaled.length) return '';
  const outline = scaled.map(([x, y]) => [x / K, y / K]);
  // Smooth the outline polygon with quadratic curves through midpoints.
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0.toFixed(2), y0.toFixed(2), ((x0 + x1) / 2).toFixed(2), ((y0 + y1) / 2).toFixed(2));
      return acc;
    },
    ['M', outline[0][0].toFixed(2), outline[0][1].toFixed(2), 'Q']
  );
  d.push('Z');
  return d.join(' ');
}

/* ================================================================
   Utility: distance from point to line segment
   ================================================================ */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/* ================================================================
   Utility: check if point is within radius of any stroke point/segment
   ================================================================ */
function strokeHitsCircle(stroke, cx, cy, radius) {
  if (!stroke.points || stroke.points.length === 0) return false;
  for (let i = 0; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    const dist = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
    if (dist <= radius) return true;
    if (i > 0) {
      const prev = stroke.points[i - 1];
      if (distToSegment(cx, cy, prev.x, prev.y, p.x, p.y) <= radius) return true;
    }
  }
  return false;
}

/* ================================================================
   Utility: check if eraser circle overlaps a node rect
   ================================================================ */
function nodeHitsCircle(node, cx, cy, radius, heightMap) {
  const w = node.width || 220;
  const h = node.height || (heightMap && heightMap[node.id]) || 60;
  // Closest point on rect to circle center
  const closestX = Math.max(node.x, Math.min(cx, node.x + w));
  const closestY = Math.max(node.y, Math.min(cy, node.y + h));
  const dist = Math.sqrt((cx - closestX) ** 2 + (cy - closestY) ** 2);
  return dist <= radius;
}

/* ================================================================
   Utility: check if arrow (bezier) hits eraser circle
   ================================================================ */
function arrowHitsCircle(arrow, nodes, cx, cy, radius, heightMap) {
  const fromNode = nodes[arrow.fromNodeId];
  const toNode = nodes[arrow.toNodeId];
  if (!fromNode || !toNode) return false;
  const from = getAnchorPos(fromNode, arrow.fromAnchor, heightMap);
  const to = getAnchorPos(toNode, arrow.toAnchor, heightMap);
  // Sample the bezier at intervals and check distance
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Simple linear approximation for hit testing
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) <= radius) return true;
  }
  return false;
}

/* ================================================================
   Utility: pixel erase - split strokes around erased points
   ================================================================ */
let pixelEraseSeq = 0;
function pixelEraseStrokes(strokes, cx, cy, radius, allow) {
  let changed = false;
  const result = [];

  for (const stroke of strokes) {
    if (!stroke.points || stroke.points.length === 0 || (allow && !allow(stroke)) || strokeFarFrom(stroke, cx, cy, radius)) {
      result.push(stroke);
      continue;
    }

    // Check if any point is within eraser radius
    let hasHit = false;
    for (const p of stroke.points) {
      if (Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2) <= radius) {
        hasHit = true;
        break;
      }
    }

    if (!hasHit) {
      result.push(stroke);
      continue;
    }

    changed = true;
    // Split points into contiguous groups outside the eraser
    const groups = [];
    let currentGroup = [];
    for (const p of stroke.points) {
      const dist = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
      if (dist > radius) {
        currentGroup.push(p);
      } else {
        if (currentGroup.length > 1) {
          groups.push(currentGroup);
        }
        currentGroup = [];
      }
    }
    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }

    // Create new strokes from groups
    for (const group of groups) {
      result.push({
        id: 's_pe_' + Date.now().toString(36) + '_' + (pixelEraseSeq++),
        points: group,
        color: stroke.color,
        width: stroke.width,
        ...(stroke.opacity != null ? { opacity: stroke.opacity } : {}),
        ...(stroke.hl ? { hl: true } : {}),
        ...(stroke.sl != null ? { sl: stroke.sl } : {}),
      });
    }
  }

  return { strokes: result, changed };
}

/* ================================================================
   Utility: check if rect overlaps another rect
   ================================================================ */
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ================================================================
   Utility: compute bounding box of a selection (nodes + strokes)
   ================================================================ */
function getSelectionBounds(sel, nodes, strokes, heightMap) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of sel.nodeIds) {
    const n = nodes[id];
    if (!n) continue;
    const w = n.width || 220;
    const h = n.height || (heightMap && heightMap[id]) || 60;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  for (const id of sel.strokeIds) {
    const s = (strokes || []).find(st => st.id === id);
    if (!s || !s.points) continue;
    for (const p of s.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ================================================================
   Lasso selection (free-form). Even-odd point-in-polygon; a stroke is taken
   when most of it lies inside the loop, a node when its centre does.
   ================================================================ */
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const LASSO_STROKE_SHARE = 0.6; // share of a stroke's points that must be inside
function lassoSelect(poly, nodes, arrows, strokes, heightMap) {
  const nodeIds = new Set(), strokeIds = new Set(), arrowIds = new Set();
  if (poly.length < 3) return { nodeIds, arrowIds, strokeIds };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  for (const n of Object.values(nodes)) {
    const cx = n.x + (n.width || 220) / 2, cy = n.y + (n.height || (heightMap && heightMap[n.id]) || 60) / 2;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && pointInPolygon(cx, cy, poly)) nodeIds.add(n.id);
  }
  for (const st of strokes || []) {
    if (!st.points || !st.points.length) continue;
    const b = boxOfStroke(st);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    const step = Math.max(1, Math.floor(st.points.length / 24)); // sample long strokes
    let total = 0, inside = 0;
    for (let i = 0; i < st.points.length; i += step) {
      total++;
      if (pointInPolygon(st.points[i].x, st.points[i].y, poly)) inside++;
    }
    if (inside / total >= LASSO_STROKE_SHARE) strokeIds.add(st.id);
  }
  for (const [aId, a] of Object.entries(arrows)) {
    if (nodeIds.has(a.fromNodeId) && nodeIds.has(a.toNodeId)) arrowIds.add(aId);
  }
  return { nodeIds, arrowIds, strokeIds };
}

/* ================================================================
   Ink rendering. A page of handwriting is thousands of strokes, so nothing
   here may cost "all strokes" per pointer event:
     · a stroke object is immutable (edits make a new object), so its outline
       and hit path are computed once and cached per object;
     · each stroke is a memoised element — it re-renders only when that
       stroke (or its selection state) changes.
   ================================================================ */
const inkPathCache = new WeakMap();
export function inkPaths(stroke) {
  let c = inkPathCache.get(stroke);
  if (!c) {
    c = { outline: gelStrokePath(stroke.points, stroke.width, stroke.shape, stroke.sl, stroke.hl), hit: pointsToPath(stroke.points) };
    inkPathCache.set(stroke, c);
  }
  return c;
}
// True when the eraser circle can't possibly touch the stroke (cheap reject
// before walking its points).
function strokeFarFrom(stroke, cx, cy, radius) {
  const b = boxOfStroke(stroke);
  const pad = radius + (stroke.width || 2);
  return cx < b.x0 - pad || cx > b.x1 + pad || cy < b.y0 - pad || cy > b.y1 + pad;
}

const InkStroke = memo(function InkStroke({ stroke, selectable, selected, onDown }) {
  const { outline, hit } = inkPaths(stroke);
  return (
    <g onMouseDown={selectable ? (e) => onDown(e, stroke.id) : undefined}>
      {/* Wide invisible hit band along the centerline — makes thin strokes
          easy to click without changing how they look. */}
      {selectable && (
        <path
          d={hit}
          fill="none"
          stroke="transparent"
          strokeWidth={Math.max(16, stroke.width || 2)}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        />
      )}
      <path
        d={outline}
        className={`freehand-stroke gel${selected ? ' in-selection' : ''}`}
        fill={stroke.color || '#cf7bf0'}
        fillOpacity={(stroke.opacity == null ? 100 : stroke.opacity) / 100}
        stroke="none"
        style={{ pointerEvents: 'none' }}
      />
    </g>
  );
});

/* ================================================================
   CANVAS COMPONENT
   ================================================================ */
export default function Canvas({
  nodes,
  arrows,
  viewport,
  selectedId,
  selectedType,
  onUpdateViewport,
  onAddNode,
  onUpdateNode,
  onAddArrow,
  onSelect,
  toolMode,
  drawColor,
  drawWidth,
  drawOpacity,
  drawFlat,
  onPlaceObject,
  figureShape,
  drawStrokes,
  onAddStroke,
  eraserMode,
  eraserRadius,
  onEraseObjects,
  onPixelErase,
  onEraseEnd,
  selection,
  onSelectionChange,
  onToggleSelect,
  onMoveSelection,
  onSelectionDragEnd,
  onNodeDragEnd,
  isMobile,
  onUpdateArrow,
  onUpdateArrowLive,
  showArrowHandles,
  sourceMode,
  regions = {},
  onUpdateRegion,
  onUpdateStroke,
  onRegionDragEnd,
  // Optional (Obsidian plugin): show an "open note" button on note-backed nodes.
  noteFor,
  onOpenNote,
  // Vim-mode (controlled by App) — see tasks/vim-mode.md
  editingNodeId,
  setEditingNodeId,
  // mode currently unused inside Canvas; kept for future hotkey routing.
  // eslint-disable-next-line no-unused-vars
  mode,
  // Keyboard arrow-drag state, owned by App. When set, Canvas renders a
  // preview line from the source node's anchor to the virtual cursor.
  kbArrowDrag,
  // App fills this ref with `{ nudge, commit }` so its WASD handler can
  // push imperative DOM updates into Canvas (avoiding a React re-render
  // per tick — the same pattern as mouse drag).
  kbNudgeApiRef,
  // Paged-document layout (src/pages.js) or null for the infinite board.
  docLayout = null,
  // Finger gestures (touch screens): two-finger tap, long press on empty space.
  onTwoFingerTap,
  onThreeFingerTap,
  onDoubleTap,
  onFingerLongPress,
  // Select tool draws a free loop (lasso) instead of a rectangle.
  selectFree = false,
  // Alt-drag on a node / stroke: duplicate it (or the selection it belongs
  // to) in place and select the copies; the drag then moves them.
  onAltDuplicate,
  // Lasso tool finished; `found` = something got selected.
  onLassoEnd,
  // Eraser target: 'all' | 'ink' (pen + highlighter) | 'pen' | 'hl'.
  eraserTarget = 'all',
  // Pen strokes start as straight lines (highlighter "straight" option).
  drawStraight = false,
  // Board assets (images) and the PDF service for sheet backgrounds.
  assets = null,
  pdf = null,
  // "Add space" tool: (y0, dy) — everything below world-y y0 moves by dy.
  onAddSpace,
  // A stylus has been used on this device before: fingers only navigate.
  penOnly = false,
  onPenSeen,
  // A click (no drag) on the selected group: (worldBounds) → options popup.
  onSelectionTap,
  // Highlighter over a PDF sheet snaps to the page's text (see src/pdf.js).
  textSnap = false,
  onAddStrokes,
}) {
  const rootRef = useRef(null);
  const transformRef = useRef(null);

  /* ---- internal refs for drag state (not React state to avoid re-renders) ---- */
  const dragState = useRef(null);      // { type: 'pan' | 'node' | 'arrow' | 'draw' | 'erase' | 'rectSelect' | 'selectionDrag', ... }
  const panRAF = useRef(null);
  const vpRef = useRef(viewport);      // always-current viewport for event handlers

  // Sync vpRef via effect instead of during render
  useEffect(() => {
    vpRef.current = viewport;
  }, [viewport]);

  // Document mode: every pan / zoom is clamped so the sheets stay on screen.
  const docLayoutRef = useRef(docLayout);
  useEffect(() => { docLayoutRef.current = docLayout; }, [docLayout]);
  const clampVp = useCallback((vp) => {
    const layout = docLayoutRef.current;
    if (!layout || !rootRef.current) return vp;
    const r = rootRef.current.getBoundingClientRect();
    return clampViewport(vp, layout, r.width, r.height);
  }, []);
  // Imperative viewport write (DOM only — no React render per frame).
  const writeVp = useCallback((next) => {
    const vp = clampVp(next);
    vpRef.current = vp;
    if (transformRef.current) {
      transformRef.current.style.transform = `translate(${vp.panX}px, ${vp.panY}px) scale(${vp.zoom})`;
    }
    const gridEl = rootRef.current?.querySelector('.canvas-grid');
    if (gridEl) {
      const gs = GRID_SIZE * vp.zoom;
      gridEl.style.backgroundSize = `${gs}px ${gs}px`;
      gridEl.style.backgroundPosition = `${vp.panX % gs}px ${vp.panY % gs}px`;
    }
    return vp;
  }, [clampVp]);
  const gestureRef = useRef({ onTwoFingerTap, onThreeFingerTap, onDoubleTap, onFingerLongPress, onPenSeen });
  useEffect(() => { gestureRef.current = { onTwoFingerTap, onThreeFingerTap, onDoubleTap, onFingerLongPress, onPenSeen }; }, [onTwoFingerTap, onThreeFingerTap, onDoubleTap, onFingerLongPress, onPenSeen]);
  const onAddStrokesRef = useRef(onAddStrokes);
  useEffect(() => { onAddStrokesRef.current = onAddStrokes; }, [onAddStrokes]);
  const onSelectionTapRef = useRef(onSelectionTap);
  useEffect(() => { onSelectionTapRef.current = onSelectionTap; }, [onSelectionTap]);
  const penOnlyRef = useRef(penOnly);
  useEffect(() => { penOnlyRef.current = penOnly; }, [penOnly]);

  /* ---- node height state for anchor position computation (state, not ref, so render can read it) ---- */
  const [nodeHeightMap, setNodeHeightMap] = useState({});
  // We also keep a mutable mirror for use inside event handlers (which run outside render)
  const nodeHeightRef = useRef({});

  /* ---- Arrow preview state (while dragging from anchor) ---- */
  const [arrowPreview, setArrowPreview] = useState(null);
  // Mirror in a ref so handlers in stale-closure useEffects can read the
  // latest preview without re-subscribing.
  const arrowPreviewRef = useRef(null);
  useEffect(() => { arrowPreviewRef.current = arrowPreview; }, [arrowPreview]);

  /* ---- Free-arrow draw state (Arrow tool: empty → empty) ---- */
  const [freeArrow, setFreeArrow] = useState(null);
  const freeArrowRef = useRef(null);
  useEffect(() => { freeArrowRef.current = freeArrow; }, [freeArrow]);

  /* ---- Placement draw state (Node / Region / Figure tools) ---- */
  const [placePreview, setPlacePreview] = useState(null);
  const placePreviewRef = useRef(null);
  useEffect(() => { placePreviewRef.current = placePreview; }, [placePreview]);
  const onPlaceObjectRef = useRef(onPlaceObject);
  useEffect(() => { onPlaceObjectRef.current = onPlaceObject; }, [onPlaceObject]);
  const figureShapeRef = useRef(figureShape);
  useEffect(() => { figureShapeRef.current = figureShape; }, [figureShape]);

  /* ---- Refs for mobile touch handler closures ---- */
  const drawColorRef = useRef(drawColor);
  useEffect(() => { drawColorRef.current = drawColor; }, [drawColor]);
  const drawWidthRef = useRef(drawWidth || 2);
  useEffect(() => { drawWidthRef.current = drawWidth || 2; }, [drawWidth]);
  const drawOpacityRef = useRef(drawOpacity == null ? 100 : drawOpacity);
  useEffect(() => { drawOpacityRef.current = drawOpacity == null ? 100 : drawOpacity; }, [drawOpacity]);
  const selectionRef = useRef(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  /* ---- Freehand drawing state ---- */
  const currentStroke = useRef(null); // { points: [{x,y},...], color, width }
  // The stroke being drawn is painted imperatively (one <path>, attributes set
  // directly): a React render per pointer sample would re-run the whole canvas.
  const previewPathRef = useRef(null);
  const setDrawingPreview = useCallback((d) => {
    const pathEl = previewPathRef.current;
    if (!pathEl) return;
    if (!d) { pathEl.style.display = 'none'; pathEl.setAttribute('d', ''); return; }
    const cs = currentStroke.current;
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('fill', (cs && cs.color) || '#cf7bf0');
    pathEl.setAttribute('fill-opacity', String(((cs && cs.opacity != null) ? cs.opacity : 100) / 100));
    pathEl.style.display = '';
  }, []);
  // Lasso tool: the loop is painted imperatively; the selection it encloses
  // is recomputed at most once per frame.
  const lassoPathRef = useRef(null);
  const lassoRAF = useRef(0);
  const paintLasso = useCallback((pts) => {
    const pathEl = lassoPathRef.current;
    if (!pathEl) return;
    if (!pts || pts.length < 2) { pathEl.style.display = 'none'; pathEl.setAttribute('d', ''); return; }
    pathEl.setAttribute('d', 'M ' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ') + ' Z');
    const z = vpRef.current.zoom;
    pathEl.setAttribute('stroke-width', String(1.5 / z));
    pathEl.setAttribute('stroke-dasharray', `${7 / z} ${7 / z}`);
    pathEl.style.display = '';
  }, []);

  // Draw-and-hold: called with the pointer's screen position on every draw
  // event. Once the pointer has rested for HOLD_SNAP_MS the stroke is offered
  // to the shape recogniser.
  const holdRef = useRef({ timer: null, x: 0, y: 0 });
  const cancelHold = useCallback(() => {
    clearTimeout(holdRef.current.timer);
    holdRef.current.timer = null;
  }, []);
  const touchHold = useCallback((sx, sy) => {
    const h = holdRef.current;
    if (h.timer && Math.hypot(sx - h.x, sy - h.y) < HOLD_STILL_PX) return; // still resting
    clearTimeout(h.timer);
    h.x = sx; h.y = sy;
    h.timer = setTimeout(() => {
      h.timer = null;
      const cs = currentStroke.current;
      if (!cs || cs.shape) return;
      const found = recognizeShape(cs.points, 24 / vpRef.current.zoom);
      if (!found) return;
      cs.points = found.kind === 'line' ? found.points.map((pt) => ({ x: magnet(pt.x), y: magnet(pt.y) })) : found.points;
      cs.shape = found.kind;
      setDrawingPreview(gelStrokePath(cs.points, cs.width, cs.shape, cs.sl, cs.hl));
    }, HOLD_SNAP_MS);
  }, []);

  /* ---- PDF text being highlighted: [{ x, y, w, h }] in world units ---- */
  const [textSel, setTextSel] = useState(null);

  /* ---- Dragging node id as state for CSS class ---- */
  const [draggingNodeId, setDraggingNodeId] = useState(null);

  /* ---- Eraser cursor position (world coords) ---- */
  const [eraserCursor, setEraserCursor] = useState(null);

  /* ---- Rectangle selection visual ---- */
  const [selectRect, setSelectRect] = useState(null); // { x, y, w, h } in world coords

  /* ================================================================
     Coordinate conversions
     ================================================================ */
  const screenToWorld = useCallback((sx, sy) => {
    const vp = vpRef.current;
    return {
      x: (sx - vp.panX) / vp.zoom,
      y: (sy - vp.panY) / vp.zoom,
    };
  }, []);

  // NOTE: keep hooks up here, not down by the JSX. eslint's rules-of-hooks
  // walks every code path from the top of the component to each hook; after
  // the thousands of branches in the render section that never finishes.
  // Strokes with unique ids (a corrupted board could carry duplicates, which
  // would collide as React keys).
  const uniqueStrokes = useMemo(() => {
    const seen = new Set();
    const uniq = (drawStrokes || []).filter((st) => (seen.has(st.id) ? false : (seen.add(st.id), true)));
    // Highlighter sits UNDER the ink, whatever was drawn first.
    if (!uniq.some((st) => st.hl)) return uniq;
    return [...uniq.filter((st) => st.hl), ...uniq.filter((st) => !st.hl)];
  }, [drawStrokes]);
  const spaceBandRef = useRef(null);
  const paintSpaceBand = (y0, dy) => {
    const el = spaceBandRef.current;
    if (!el) return;
    if (y0 == null) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.top = Math.min(y0, y0 + dy) + 'px';
    el.style.height = Math.abs(dy) + 'px';
    el.classList.toggle('closing', dy < 0);
  };
  // Click / drag on a stroke in Select mode. Kept in a ref behind a stable
  // callback so the memoised stroke elements don't re-render with the canvas.
  const strokeDown = (e, strokeId) => {
    if (toolMode !== 'select') return;
    e.stopPropagation();
    onSelect(null, null);
    // Alt-drag: drag a copy. Otherwise keep a multi-selection if this stroke is
    // already part of one, or select just this stroke.
    if (e.altKey && onAltDuplicate) {
      onAltDuplicate('stroke', strokeId);
    } else if (!selection.strokeIds.has(strokeId)) {
      onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set([strokeId]) });
    }
    // Start a move drag immediately (drag to reposition the stroke).
    const rect = rootRef.current.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    dragState.current = {
      type: 'selectionDrag',
      startWorldX: world.x, startWorldY: world.y,
      lastWorldX: world.x, lastWorldY: world.y,
    };
  };
  const strokeDownRef = useRef(strokeDown);
  useEffect(() => { strokeDownRef.current = strokeDown; });
  const onStrokeMouseDown = useCallback((e, strokeId) => strokeDownRef.current(e, strokeId), []);


  /* ================================================================
     Zoom (mouse-centric)
     ================================================================ */
  // Debounce timer for syncing zoom to React state
  const zoomSyncTimer = useRef(null);

  const applyZoom = useCallback((factor, cx, cy) => {
    const vp = vpRef.current;
    let newZoom = vp.zoom * factor;
    newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const scale = newZoom / vp.zoom;
    // Update vpRef + DOM directly (no React re-render per zoom frame)
    writeVp({ zoom: newZoom, panX: cx - (cx - vp.panX) * scale, panY: cy - (cy - vp.panY) * scale });
    // Debounce React state sync
    clearTimeout(zoomSyncTimer.current);
    zoomSyncTimer.current = setTimeout(() => {
      onUpdateViewport({ ...vpRef.current });
    }, 150);
  }, [onUpdateViewport, writeVp]);

  /* ================================================================
     Wheel handler - Ctrl/Meta = zoom, otherwise pan
     ================================================================ */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    // Debounce: sync React state after wheel stops (not on every event)
    let wheelSyncTimer = null;

    function onWheel(e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        // Scale zoom by event magnitude so trackpad pinch (many small events)
        // and mouse wheel (few large events) both feel gentle.
        // exp(-dy * k) is smooth and symmetric; k tuned low for trackpad.
        const dy = Math.max(-50, Math.min(50, e.deltaY));
        const factor = Math.exp(-dy * 0.0035);
        applyZoom(factor, mx, my);
      } else {
        // Update DOM directly — no React re-render per wheel event.
        // Mac trackpad generates dozens of wheel events per second;
        // calling setState on each one causes React to diff 30+ KaTeX
        // DOM trees per frame, causing severe lag.
        const vp = vpRef.current;
        writeVp({ ...vp, panX: vp.panX - e.deltaX, panY: vp.panY - e.deltaY });
        // Sync React state after scrolling stops (150ms debounce)
        clearTimeout(wheelSyncTimer);
        wheelSyncTimer = setTimeout(() => {
          onUpdateViewport({ ...vpRef.current });
        }, 150);
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, onUpdateViewport, writeVp]);

  /* ================================================================
     Touch + stylus — wide screens (iPad, touch laptops)
     The desktop interaction model is mouse-driven and complete, so instead
     of a second implementation the stylus is REPLAYED through it as
     synthetic mouse events (with its pressure riding along). Fingers:
       · 1 finger on empty space        → pan (tap = click, long press = pen options)
       · 1 finger on an object          → acts like the mouse (drag, resize, …)
       · 2 fingers                      → pinch-zoom + pan; a two-finger TAP
                                          toggles eraser ⇄ last tool
     Once a stylus has touched the board, fingers never draw or erase —
     they only navigate (palm rejection: fingers are ignored while the pen
     is down).
     ================================================================ */
  useEffect(() => {
    if (isMobile) return; // phones have their own handler below
    const el = rootRef.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView || window;

    const TAP_MS = 350, TAP_MOVE = 12, LONG_MS = 550;
    const BG_CLASSES = ['canvas-grid', 'canvas-transform', 'drawing-layer', 'eraser-hit-layer', 'select-hit-layer'];
    // Once a stylus has been used on this device, fingers never draw — and
    // that is remembered across sessions (see `penOnly`).
    let penSeen = !!penOnlyRef.current;
    let lastPenT = 0;    // when the stylus last touched / left the board
    const PALM_GUARD_MS = 1200;
    let g = null;        // the gesture in progress
    let penIsDown = false;
    // Momentum after a finger scroll (exponential decay, like a native list).
    let glide = 0;
    let glideV = null;   // current glide velocity, px/ms
    // Stopping does not commit by itself: a commit re-renders the board, and
    // doing that under a finger that has just landed delays its first moves.
    // → true when a glide was running (the caller commits when it is ready).
    const stopGlide = () => {
      if (!glide) return null;
      cancelAnimationFrame(glide); glide = 0;
      const v = glideV; glideV = null;
      return v || { vx: 0, vy: 0 };
    };
    const MAX_V = 9; // px/ms
    function startGlide(vx, vy) {
      const sp = Math.hypot(vx, vy);
      if (sp > MAX_V) { vx *= MAX_V / sp; vy *= MAX_V / sp; }
      const TAU = 325; // ms
      let last = 0;
      glideV = { vx, vy };
      const step = (now) => {
        // The first frame only sets the clock (rAF time ≠ event time).
        const dt = last ? Math.max(0, Math.min(48, now - last)) : 0;
        last = now;
        if (dt) {
          const before = vpRef.current;
          const after = writeVp({ ...before, panX: before.panX + glideV.vx * dt, panY: before.panY + glideV.vy * dt });
          const k = Math.exp(-dt / TAU);
          glideV.vx *= k; glideV.vy *= k;
          // An axis the document edge swallowed stops; the other keeps going.
          if (after.panX === before.panX) glideV.vx = 0;
          if (after.panY === before.panY) glideV.vy = 0;
          if (Math.hypot(glideV.vx, glideV.vy) < 0.02) { glide = 0; glideV = null; commitVp(); return; }
        }
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    }
    // Speed of a trail of { x, y, t } samples (t = event time) over its last
    // ~100 ms — null when the contact had stopped before it lifted.
    function trailVelocity(trail, endT) {
      if (!trail || trail.length < 2) return null;
      const b = trail[trail.length - 1];
      if (endT - b.t > 100) return null;
      let a = trail[0];
      for (const s of trail) { if (b.t - s.t <= 100) { a = s; break; } }
      const dt = b.t - a.t;
      if (dt < 4) return null;
      return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt, span: dt };
    }
    const pushTrail = (trail, x, y, t) => {
      trail.push({ x, y, t });
      while (trail.length > 3 && t - trail[0].t > 160) trail.shift();
    };
    // Glide after a scroll; a flick made while the page is still gliding the
    // same way adds to it (the way repeated flicks speed a native list up).
    function fling(v, carry) {
      if (!v || Math.hypot(v.vx, v.vy) < 0.1) return false;
      let { vx, vy } = v;
      if (carry && carry.vx * vx + carry.vy * vy > 0) { vx += carry.vx; vy += carry.vy; }
      startGlide(vx, vy);
      return true;
    }
    const inPalmWindow = () => penIsDown || (penSeen && Date.now() - lastPenT < PALM_GUARD_MS);
    let lastTap = null;  // { t, x, y } — for double-tap → dblclick
    let lastBgTap = null; // finger taps on empty space — for the double-tap gesture

    const isStylus = (t) => t.touchType === 'stylus';
    const isBackground = (target) => target === el
      || !!(target && target.classList && BG_CLASSES.some((c) => target.classList.contains(c)));
    const find = (list, id) => { for (const t of list) if (t.identifier === id) return t; return null; };
    const fire = (type, t, target) => {
      (target || el).dispatchEvent(new win.MouseEvent(type, {
        bubbles: true, cancelable: true, view: win, detail: type === 'dblclick' ? 2 : 1,
        clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY,
        button: 0, buttons: type === 'mousedown' || type === 'mousemove' ? 1 : 0,
      }));
    };
    const pressureOf = (t) => (isStylus(t) && t.force > 0 ? Math.min(1, t.force) : null);
    const commitVp = () => onUpdateViewport({ ...vpRef.current });
    const clearLong = () => { if (g && g.longTimer) { clearTimeout(g.longTimer); g.longTimer = null; } };

    // Pointer events carry what touch events lack for a stylus: sub-pixel
    // positions and (where supported) the coalesced samples between frames.
    // The touch events still drive the gesture; these only refine the ink —
    // if they never arrive, drawing falls back to the touch coordinates.
    let penDown = null;
    function onPenDown(e) {
      if (e.pointerType === 'pen') penDown = { x: e.clientX, y: e.clientY, t: Date.now() };
    }
    function onPenMove(e) {
      if (e.pointerType !== 'pen' || !g || g.type !== 'mouse' || !g.stylus) return;
      g.pointerT = Date.now();
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const list = coalesced && coalesced.length ? coalesced : [e];
      const lastS = list[list.length - 1];
      if (!g.moved && Math.hypot(lastS.clientX - g.startX, lastS.clientY - g.startY) > TAP_MOVE) g.moved = true;
      g.lastX = lastS.clientX; g.lastY = lastS.clientY;
      const cs = currentStroke.current;
      if (dragState.current && dragState.current.type === 'draw' && cs) {
        const rect = el.getBoundingClientRect();
        const vp = vpRef.current;
        for (const sample of list) {
          if (sample.pressure > 0) activePenPressure = Math.min(1, sample.pressure);
          appendStrokePoint(cs, (sample.clientX - rect.left - vp.panX) / vp.zoom, (sample.clientY - rect.top - vp.panY) / vp.zoom);
        }
        touchHold(lastS.clientX, lastS.clientY);
        setDrawingPreview(gelStrokePath(cs.points, cs.width, cs.shape, cs.sl, cs.hl));
      } else {
        fire('mousemove', lastS);
      }
    }

    function startMouse(t, stylus) {
      g = { type: 'mouse', id: t.identifier, stylus, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY, t0: Date.now(), moved: false, pointerT: 0 };
      activePenPressure = pressureOf(t);
      const precise = stylus && penDown && Date.now() - penDown.t < 150 && Math.hypot(penDown.x - t.clientX, penDown.y - t.clientY) < 3;
      activePenPos = precise ? { x: penDown.x, y: penDown.y } : null;
      activeTouchInput = true;
      if (stylus) { lastPenT = Date.now(); penIsDown = true; }
      fire('mousedown', t, t.target);
      activePenPos = null;
    }
    function endMouse(t, cancelled) {
      const point = t || { clientX: g.lastX, clientY: g.lastY, screenX: 0, screenY: 0 };
      if (g.stylus) { lastPenT = Date.now(); penIsDown = false; }
      fire('mouseup', point);
      activePenPressure = null;
      activeTouchInput = false;
      const wasTap = !cancelled && !g.moved && Date.now() - g.t0 < TAP_MS * 2;
      g = null;
      // A short stroke with a drawing tool is ink (a dot, a comma), never a click.
      const tool = toolModeRef.current;
      if (!wasTap || tool === 'draw' || tool === 'eraser') return;
      const target = el.ownerDocument.elementFromPoint(point.clientX, point.clientY) || el;
      fire('click', point, target);
      const now = Date.now();
      if (lastTap && now - lastTap.t < TAP_MS && Math.hypot(point.clientX - lastTap.x, point.clientY - lastTap.y) < 30) {
        fire('dblclick', point, target);
        lastTap = null;
      } else {
        lastTap = { t: now, x: point.clientX, y: point.clientY };
      }
    }
    function startPan(t) {
      // Right after the pen was writing, a lone contact is most likely the
      // resting hand: it may still scroll, but only after a decisive move, and
      // it never counts as a long press.
      const guard = penSeen && Date.now() - lastPenT < PALM_GUARD_MS;
      g = { type: 'pan', id: t.identifier, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY, t0: Date.now(), moved: false, maxTouches: 1, longTimer: null, guard, vp0: { ...vpRef.current }, trail: [{ x: t.clientX, y: t.clientY, t: evT }] };
      if (guard) return;
      const mine = g;
      g.longTimer = setTimeout(() => {
        if (g !== mine || g.type !== 'pan' || g.moved) return;
        g.moved = true; // no tap afterwards
        gestureRef.current.onFingerLongPress?.({ x: mine.startX, y: mine.startY });
      }, LONG_MS);
    }
    function startPinch(a, b, from) {
      g = {
        type: 'pinch', ids: [a.identifier, b.identifier],
        last: [{ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }],
        start: [{ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }],
        t0: from ? from.t0 : Date.now(),
        moved: from ? from.moved : false,
        maxTouches: 2,
        guard: inPalmWindow(),
        vp0: from && from.vp0 ? from.vp0 : { ...vpRef.current },
        trail: [{ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, t: evT }],
        dirty: from ? from.dirty : false,
        carry: from ? from.carry : null,
      };
    }

    let evT = 0; // time stamp of the event being handled
    function onTouchStart(e) {
      evT = e.timeStamp;
      const stopped = stopGlide();
      const target = e.target;
      // Let native handle text being edited and real controls.
      if (target.closest && (target.closest('[contenteditable="true"]') || target.closest('input, textarea, select, button, a'))) { if (stopped) commitVp(); return; }
      e.preventDefault();
      e.stopPropagation(); // keep the host app's swipe gestures (Obsidian sidebars) out of it

      for (const t of e.changedTouches) {
        if (g && g.type === 'mouse' && g.stylus) continue; // palm while writing
        if (isStylus(t)) {
          if (!penSeen) { penSeen = true; gestureRef.current.onPenSeen?.(); }
          if (g) { // fingers were navigating — the pen takes over
            clearLong();
            if (g.type === 'mouse') endMouse(null, true);
            else {
              // A hand that landed just before the pen was not a gesture: put
              // the view back where it was.
              if (g.vp0 && Date.now() - g.t0 < 1500) writeVp(g.vp0);
              commitVp(); g = null;
            }
          }
          startMouse(t, true);
          continue;
        }
        if (!g) {
          const tool = toolModeRef.current;
          const drawing = tool === 'draw' || tool === 'eraser';
          const placing = tool === 'node' || tool === 'region' || tool === 'figure' || tool === 'arrow' || tool === 'lasso';
          const bg = isBackground(t.target);
          const actAsMouse = penSeen ? (!drawing && !bg) : (drawing || placing || !bg);
          if (actAsMouse) startMouse(t, false); else startPan(t);
        } else if (g.type === 'pan') {
          clearLong();
          const first = find(e.touches, g.id);
          evT = e.timeStamp;
          if (first) startPinch(first, t, g);
          if (g && g.type === 'pinch' && inPalmWindow()) g.guard = true;
        } else if (g.type === 'mouse') {
          // A second finger turns a finger-drag into a pinch. Drop a stroke
          // that was only just begun rather than leaving a stray dot.
          const first = find(e.touches, g.id);
          // (Excalidraw's rule: under 10 points it was an accident; a longer one is kept.)
          if (dragState.current && dragState.current.type === 'draw' && currentStroke.current && currentStroke.current.points.length < 10) { currentStroke.current = null; setDrawingPreview(null); }
          const from = { t0: g.t0, moved: g.moved, dirty: false, carry: null };
          endMouse(first, true);
          if (first) startPinch(first, t, from);
        } else if (g.type === 'pinch') {
          g.maxTouches = Math.max(g.maxTouches, e.touches.length);
          g.t0 = g.t0 || Date.now();
        }
      }
      // A glide this touch interrupted: a scroll gesture commits the view when
      // it ends; anything else needs the real viewport now.
      if (stopped) {
        if (g && (g.type === 'pan' || g.type === 'pinch')) { g.dirty = true; g.carry = stopped; }
        else commitVp();
      }
    }

    function onTouchMove(e) {
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      if (g.type === 'mouse') {
        const t = find(e.touches, g.id);
        if (!t) return;
        if (!g.moved && Math.hypot(t.clientX - g.startX, t.clientY - g.startY) > TAP_MOVE) g.moved = true;
        g.lastX = t.clientX; g.lastY = t.clientY;
        // The pointer-event path already fed this movement (with better data).
        if (g.stylus && Date.now() - g.pointerT < 120) return;
        if (g.stylus) { const p = pressureOf(t); if (p != null) activePenPressure = p; }
        fire('mousemove', t);
      } else if (g.type === 'pan') {
        const t = find(e.touches, g.id);
        if (!t) return;
        // Velocity samples start with the very first move, so a short flick
        // still has a speed to glide with.
        pushTrail(g.trail, t.clientX, t.clientY, e.timeStamp);
        if (!g.moved && Math.hypot(t.clientX - g.startX, t.clientY - g.startY) < (g.guard ? TAP_MOVE * 2 : TAP_MOVE / 2)) return;
        if (!g.moved) { g.moved = true; clearLong(); g.lastX = t.clientX; g.lastY = t.clientY; return; }
        const vp = vpRef.current;
        writeVp({ ...vp, panX: vp.panX + (t.clientX - g.lastX), panY: vp.panY + (t.clientY - g.lastY) });
        g.lastX = t.clientX; g.lastY = t.clientY;
      } else if (g.type === 'pinch') {
        const a = find(e.touches, g.ids[0]), b = find(e.touches, g.ids[1]);
        if (!a || !b) return;
        const cur = [{ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }];
        if (!g.moved) {
          const d0 = Math.hypot(cur[0].x - g.start[0].x, cur[0].y - g.start[0].y);
          const d1 = Math.hypot(cur[1].x - g.start[1].x, cur[1].y - g.start[1].y);
          const need = g.guard ? TAP_MOVE * 3 : TAP_MOVE;
          if (d0 < need && d1 < need) return;
          g.moved = true; g.last = cur; return;
        }
        const rect = el.getBoundingClientRect();
        const prev = g.last;
        const prevDist = Math.hypot(prev[1].x - prev[0].x, prev[1].y - prev[0].y) || 1;
        const curDist = Math.hypot(cur[1].x - cur[0].x, cur[1].y - cur[0].y) || 1;
        const pmx = (prev[0].x + prev[1].x) / 2 - rect.left, pmy = (prev[0].y + prev[1].y) / 2 - rect.top;
        const cmx = (cur[0].x + cur[1].x) / 2 - rect.left, cmy = (cur[0].y + cur[1].y) / 2 - rect.top;
        const vp = vpRef.current;
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * (curDist / prevDist)));
        const k = zoom / vp.zoom;
        writeVp({ zoom, panX: cmx - (pmx - vp.panX) * k, panY: cmy - (pmy - vp.panY) * k });
        pushTrail(g.trail, cmx, cmy, e.timeStamp);
        // A two-finger scroll glides; a zoom does not.
        if (Math.abs(Math.log(curDist / Math.hypot(g.start[1].x - g.start[0].x, g.start[1].y - g.start[0].y))) > 0.12) g.zoomed = true;
        g.last = cur;
      }
    }

    function finish(e, cancelled) {
      if (!g) return;
      if (g.type === 'mouse') {
        const t = find(e.changedTouches, g.id);
        if (t) endMouse(t, cancelled);
      } else if (g.type === 'pan') {
        const t = find(e.changedTouches, g.id);
        if (!t) return;
        clearLong();
        const done = g;
        g = null;
        if (done.moved && !cancelled) {
          // Speed from the event time stamps: the handlers can run late (a busy
          // frame delivers several moves at once), the stamps do not.
          let v = trailVelocity(done.trail, e.timeStamp);
          // The last finger of a two-finger scroll lifts a moment after the
          // first: it has no trail of its own yet, the pair's speed counts.
          if ((!v || v.span < 30) && done.pinchV && e.timeStamp - done.pinchV.t < 140) v = done.pinchV;
          if (fling(v, done.carry)) return;
        }
        if (done.moved || cancelled || done.dirty) { commitVp(); return; }
        if (done.guard) return;
        // Two quick taps: eraser ⇄ last tool.
        const nowTap = Date.now();
        if (lastBgTap && nowTap - lastBgTap.t < 300 && Math.hypot(t.clientX - lastBgTap.x, t.clientY - lastBgTap.y) < 35) {
          lastBgTap = null;
          gestureRef.current.onDoubleTap?.();
          return;
        }
        lastBgTap = { t: nowTap, x: t.clientX, y: t.clientY };
        // A finger tap on empty space is a click there (deselects) — except
        // with a drawing tool, where a click would start a stroke.
        const tool = toolModeRef.current;
        if (tool === 'draw' || tool === 'eraser') return;
        const target = el.ownerDocument.elementFromPoint(t.clientX, t.clientY) || el;
        fire('mousedown', t, target); fire('mouseup', t); fire('click', t, target);
      } else if (g.type === 'pinch') {
        if (e.touches.length >= 2 && find(e.touches, g.ids[0]) && find(e.touches, g.ids[1])) return;
        const done = g;
        g = null;
        if (!done.moved && !cancelled && !done.guard && Date.now() - done.t0 < TAP_MS && (done.maxTouches === 2 || done.maxTouches === 3)) {
          if (done.maxTouches === 3) gestureRef.current.onThreeFingerTap?.();
          else gestureRef.current.onTwoFingerTap?.();
          // The remaining fingers of this tap are lifting too — not a new gesture.
          if (done.dirty) commitVp();
          return;
        }
        // One finger still down: keep panning with it (its end commits the view).
        const rest = find(e.touches, done.ids[0]) || find(e.touches, done.ids[1]);
        const pv = done.moved && !cancelled && !done.zoomed ? trailVelocity(done.trail, e.timeStamp) : null;
        if (rest) {
          evT = e.timeStamp;
          startPan(rest); clearLong(); g.moved = true;
          g.carry = done.carry;
          if (pv) g.pinchV = { ...pv, t: e.timeStamp };
        } else if (!fling(pv, done.carry)) commitVp();
      }
    }
    const onTouchEnd = (e) => finish(e, false);
    const onTouchCancel = (e) => finish(e, true);

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchCancel, { passive: false });
    el.addEventListener('pointerdown', onPenDown);
    el.addEventListener('pointermove', onPenMove);
    // While the pen is writing (or has just lifted), a finger / palm landing
    // on a toolbar or panel is not a press.
    const host = el.closest('.catego-root') || el.parentElement;
    function onPanelTouch(e) {
      if (!inPalmWindow()) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t || isStylus(t)) return;
      if (e.target.closest && e.target.closest('.toolbar, .props-panel, .pen-toolbar, .page-menu')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    if (host) host.addEventListener('touchstart', onPanelTouch, { capture: true, passive: false });
    return () => {
      if (host) host.removeEventListener('touchstart', onPanelTouch, { capture: true });
      if (glide) cancelAnimationFrame(glide);
      clearLong();
      activePenPressure = null;
      el.removeEventListener('pointerdown', onPenDown);
      el.removeEventListener('pointermove', onPenMove);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [isMobile, onUpdateViewport, writeVp, touchHold]);

  /* ================================================================
     Touch handling — MOBILE
     1 finger behavior depends on toolMode:
       - 'move': pan + drag nodes + create arrows + tap to edit
       - 'draw': draw stroke
       - 'eraser': erase
       - 'select': rect selection
     2 fingers: ALWAYS pinch zoom + pan (any tool mode)
     ================================================================ */
  // Touch state as ref so it survives React re-renders during touch gestures
  // (e.g. erasing objects triggers re-render which could reset local variables)
  const touchStateRef = useRef(null);

  useEffect(() => {
    if (!isMobile) return;
    const el = rootRef.current;
    if (!el) return;

    const getDist = (t1, t2) => Math.sqrt((t1.clientX - t2.clientX) ** 2 + (t1.clientY - t2.clientY) ** 2);
    const getMid = (t1, t2) => ({ x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 });

    // Helper: find if touch is near an anchor dot on any node (within threshold px)
    // Skips text-style nodes (they have no anchors).
    function findNearAnchor(world, threshold) {
      const currentNodes = nodesRef.current;
      const hm = nodeHeightRef.current;
      for (const nid of Object.keys(currentNodes)) {
        const n = currentNodes[nid];
        if (n.style === 'text') continue;
        for (const a of ANCHORS) {
          const pos = getAnchorPos(n, a, hm);
          const dist = Math.sqrt((world.x - pos.x) ** 2 + (world.y - pos.y) ** 2);
          if (dist < threshold / vpRef.current.zoom) {
            return { nodeId: nid, anchor: a };
          }
        }
      }
      return null;
    }

    function switchToPinch(e) {
      // Save partial stroke if we were drawing
      if (touchStateRef.current && touchStateRef.current.type === 'draw' && currentStroke.current) {
        if (currentStroke.current.points.length > 1 && onAddStroke) {
          onAddStroke({ ...currentStroke.current });
        }
        currentStroke.current = null;
        setDrawingPreview(null);
      }
      // Cancel any rect selection
      if (touchStateRef.current && touchStateRef.current.type === 'rectSelect') {
        setSelectRect(null);
      }
      const dist = getDist(e.touches[0], e.touches[1]);
      const mid = getMid(e.touches[0], e.touches[1]);
      const vp = vpRef.current;
      touchStateRef.current = {
        type: 'pinch',
        initialDist: dist,
        initialZoom: vp.zoom,
        initialPanX: vp.panX,
        initialPanY: vp.panY,
        lastMid: mid,
      };
    }

    function onTouchStart(e) {
      // Don't capture touches on toolbar or draw options
      if (e.target.closest('.toolbar') || e.target.closest('.draw-options')) return;

      e.preventDefault();

      // 2 fingers: ALWAYS pinch zoom + pan, regardless of tool
      if (e.touches.length === 2) {
        switchToPinch(e);
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = el.getBoundingClientRect();
        const mx = t.clientX - rect.left;
        const my = t.clientY - rect.top;
        const world = screenToWorld(mx, my);
        const mode = toolModeRef.current;

        // Check if touching a node
        const currentNodes = nodesRef.current;
        const hm = nodeHeightRef.current;
        let hitNodeId = null;
        for (const nid of Object.keys(currentNodes)) {
          const n = currentNodes[nid];
          const w = n.width || 220;
          const h = hm[nid] || 60;
          if (world.x >= n.x && world.x <= n.x + w && world.y >= n.y && world.y <= n.y + h) {
            hitNodeId = nid;
            break;
          }
        }

        // === MOVE MODE (default on mobile) ===
        // Pan canvas, but also: drag nodes, create arrows from anchors, tap to select/edit
        if (mode === 'move') {
          // Check if touch is near an anchor -> start arrow creation
          const anchorHit = findNearAnchor(world, 20);
          if (anchorHit) {
            touchStateRef.current = {
              type: 'arrow-preview',
              fromNodeId: anchorHit.nodeId,
              fromAnchor: anchorHit.anchor,
              moved: false,
            };
            setArrowPreview({
              fromNodeId: anchorHit.nodeId,
              fromAnchor: anchorHit.anchor,
              cursorX: world.x,
              cursorY: world.y,
              snapNodeId: null,
              snapAnchor: null,
            });
            return;
          }

          if (hitNodeId) {
            // Check if part of multi-selection -> group drag
            const sel = selectionRef.current;
            if (sel.nodeIds.has(hitNodeId) && (sel.nodeIds.size > 1 || sel.strokeIds.size > 0)) {
              touchStateRef.current = {
                type: 'selectionDrag',
                startWorldX: world.x,
                startWorldY: world.y,
                lastWorldX: world.x,
                lastWorldY: world.y,
              };
              return;
            }
            // Drag single node (offset from node origin, not just left edge)
            const n = currentNodes[hitNodeId];
            onSelect(hitNodeId, 'node');
            touchStateRef.current = {
              type: 'node-drag',
              nodeId: hitNodeId,
              offsetX: world.x - n.x,
              offsetY: world.y - n.y,
              startX: t.clientX,
              startY: t.clientY,
              moved: false,
            };
            setDraggingNodeId(hitNodeId);
            return;
          }

          // Background: pan
          touchStateRef.current = {
            type: 'pan',
            lastX: t.clientX,
            lastY: t.clientY,
            startX: t.clientX,
            startY: t.clientY,
            moved: false,
          };
          return;
        }

        // === SELECT MODE (rect selection) ===
        if (mode === 'select') {
          // Check if inside selection bounding box -> drag selection
          const sel = selectionRef.current;
          if (sel.strokeIds.size > 0 || sel.nodeIds.size > 0) {
            const bounds = getSelectionBounds(sel, currentNodes, drawStrokesRef.current, hm);
            if (bounds && world.x >= bounds.x && world.x <= bounds.x + bounds.w &&
                world.y >= bounds.y && world.y <= bounds.y + bounds.h) {
              touchStateRef.current = {
                type: 'selectionDrag',
                startWorldX: world.x,
                startWorldY: world.y,
                lastWorldX: world.x,
                lastWorldY: world.y,
              };
              return;
            }
          }

          // Background drag -> rect selection
          onSelect(null, null);
          onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
          touchStateRef.current = {
            type: 'rectSelect',
            startWorld: world,
            startScreen: { x: mx, y: my },
            moved: false,
          };
          return;
        }

        // === DRAW MODE ===
        if (mode === 'draw') {
          currentStroke.current = { points: [{ x: world.x, y: world.y }], color: drawColorRef.current || '#cf7bf0', width: drawWidthRef.current || 2, opacity: drawOpacityRef.current, sl: STREAMLINE_PRECISE };
          touchStateRef.current = { type: 'draw' };
          setDrawingPreview(gelStrokePath([{ x: world.x, y: world.y }], (currentStroke.current && currentStroke.current.width) || drawWidthRef.current || 2));
          return;
        }

        // === ERASER MODE ===
        if (mode === 'eraser') {
          touchStateRef.current = { type: 'erase' };
          setEraserCursor(world);
          if (performEraseRef.current) performEraseRef.current(world.x, world.y);
          return;
        }

        // Fallback: pan
        touchStateRef.current = {
          type: 'pan',
          lastX: t.clientX,
          lastY: t.clientY,
          startX: t.clientX,
          startY: t.clientY,
          moved: false,
        };
      }
    }

    function onTouchMove(e) {
      if (!touchStateRef.current) return;
      e.preventDefault();

      // 2 fingers: always pinch
      if (e.touches.length === 2) {
        if (touchStateRef.current.type !== 'pinch') {
          switchToPinch(e);
          return;
        }
        const dist = getDist(e.touches[0], e.touches[1]);
        const mid = getMid(e.touches[0], e.touches[1]);
        const scale = dist / touchStateRef.current.initialDist;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, touchStateRef.current.initialZoom * scale));
        const rect = el.getBoundingClientRect();
        const mx = mid.x - rect.left;
        const my = mid.y - rect.top;
        const zoomRatio = newZoom / touchStateRef.current.initialZoom;
        onUpdateViewport({
          panX: mx - (mx - touchStateRef.current.initialPanX) * zoomRatio,
          panY: my - (my - touchStateRef.current.initialPanY) * zoomRatio,
          zoom: newZoom,
        });
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = el.getBoundingClientRect();
        const mx = t.clientX - rect.left;
        const my = t.clientY - rect.top;
        const vp = vpRef.current;
        const wx = (mx - vp.panX) / vp.zoom;
        const wy = (my - vp.panY) / vp.zoom;

        if (touchStateRef.current.type === 'draw') {
          if (currentStroke.current) {
            touchHold(t.clientX, t.clientY);
            appendStrokePoint(currentStroke.current, wx, wy);
            setDrawingPreview(gelStrokePath(currentStroke.current.points, currentStroke.current.width, currentStroke.current.shape, currentStroke.current.sl, currentStroke.current.hl));
          }
        } else if (touchStateRef.current.type === 'erase') {
          setEraserCursor({ x: wx, y: wy });
          if (performEraseRef.current) performEraseRef.current(wx, wy);
        } else if (touchStateRef.current.type === 'node-drag') {
          touchStateRef.current.moved = true;
          onUpdateNode(touchStateRef.current.nodeId, { x: snap(wx - touchStateRef.current.offsetX), y: snap(wy - touchStateRef.current.offsetY) });
        } else if (touchStateRef.current.type === 'selectionDrag') {
          const dx = snap(wx - touchStateRef.current.lastWorldX);
          const dy = snap(wy - touchStateRef.current.lastWorldY);
          if (dx !== 0 || dy !== 0) {
            onMoveSelection(dx, dy);
            touchStateRef.current.lastWorldX += dx;
            touchStateRef.current.lastWorldY += dy;
          }
        } else if (touchStateRef.current.type === 'rectSelect') {
          touchStateRef.current.moved = true;
          const currentWorld = { x: wx, y: wy };
          const startWorld = touchStateRef.current.startWorld;
          const rx = Math.min(startWorld.x, currentWorld.x);
          const ry = Math.min(startWorld.y, currentWorld.y);
          const rw = Math.abs(currentWorld.x - startWorld.x);
          const rh = Math.abs(currentWorld.y - startWorld.y);
          setSelectRect({ x: rx, y: ry, w: rw, h: rh });

          // Compute selection
          const selRect = { x: rx, y: ry, w: rw, h: rh };
          const currentNodes = nodesRef.current;
          const currentArrows = arrowsRef.current;
          const currentStrokes = drawStrokesRef.current || [];
          const hm = nodeHeightRef.current;

          const selNodeIds = new Set();
          const selStrokeIds = new Set();
          const selArrowIds = new Set();

          for (const node of Object.values(currentNodes)) {
            const nw = node.width || 220;
            const nh = (hm && hm[node.id]) || 60;
            const nodeRect = { x: node.x, y: node.y, w: nw, h: nh };
            if (rectsOverlap(selRect, nodeRect)) {
              selNodeIds.add(node.id);
            }
          }

          for (const stroke of currentStrokes) {
            if (stroke.points && stroke.points.some(p => p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh)) {
              selStrokeIds.add(stroke.id);
            }
          }

          for (const [aId, arrow] of Object.entries(currentArrows)) {
            if (selNodeIds.has(arrow.fromNodeId) || selNodeIds.has(arrow.toNodeId)) {
              selArrowIds.add(aId);
            }
          }

          onSelectionChange({ nodeIds: selNodeIds, arrowIds: selArrowIds, strokeIds: selStrokeIds });
        } else if (touchStateRef.current.type === 'arrow-preview') {
          touchStateRef.current.moved = true;
          const currentNodes = nodesRef.current;
          const hm = nodeHeightRef.current;
          let snapNodeId = null;
          let snapAnchor = null;
          const SNAP_DIST = 30;
          for (const nid of Object.keys(currentNodes)) {
            if (nid === touchStateRef.current.fromNodeId) continue;
            const { anchor, dist } = closestAnchor(currentNodes[nid], wx, wy, hm);
            if (dist < SNAP_DIST) {
              snapNodeId = nid;
              snapAnchor = anchor;
              break;
            }
          }
          // Fallback: drop inside the node's bounding box → snap to nearest side.
          if (!snapNodeId) {
            for (const nid of Object.keys(currentNodes)) {
              if (nid === touchStateRef.current.fromNodeId) continue;
              const n = currentNodes[nid];
              const w = n.width || 220;
              const h = n.height || hm[nid] || 60;
              if (wx >= n.x && wx <= n.x + w && wy >= n.y && wy <= n.y + h) {
                const dL = wx - n.x, dR = n.x + w - wx;
                const dT = wy - n.y, dB = n.y + h - wy;
                const m = Math.min(dL, dR, dT, dB);
                snapNodeId = nid;
                snapAnchor = m === dL ? 'left' : m === dR ? 'right' : m === dT ? 'top' : 'bottom';
                break;
              }
            }
          }
          setArrowPreview({
            fromNodeId: touchStateRef.current.fromNodeId,
            fromAnchor: touchStateRef.current.fromAnchor,
            cursorX: wx,
            cursorY: wy,
            snapNodeId,
            snapAnchor,
          });
        } else if (touchStateRef.current.type === 'pan') {
          const dx = t.clientX - touchStateRef.current.lastX;
          const dy = t.clientY - touchStateRef.current.lastY;
          if (!touchStateRef.current.moved && Math.abs(t.clientX - touchStateRef.current.startX) < 4 && Math.abs(t.clientY - touchStateRef.current.startY) < 4) return;
          touchStateRef.current.moved = true;
          touchStateRef.current.lastX = t.clientX;
          touchStateRef.current.lastY = t.clientY;
          onUpdateViewport({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy });
        } else if (touchStateRef.current.type === 'pinch') {
          // Went from 2 fingers to 1 -- switch to pan
          touchStateRef.current = { type: 'pan', lastX: t.clientX, lastY: t.clientY, startX: t.clientX, startY: t.clientY, moved: false };
        }
      }
    }

    function onTouchEnd(e) {
      if (!touchStateRef.current) return;

      if (e.touches.length === 0) {
        if (touchStateRef.current.type === 'draw') {
          cancelHold();
          if (currentStroke.current && currentStroke.current.points.length > 1 && onAddStroke) {
            onAddStroke({ ...currentStroke.current });
          }
          currentStroke.current = null;
          setDrawingPreview(null);
        }
        if (touchStateRef.current.type === 'erase') {
          setEraserCursor(null);
          if (onEraseEndRef.current) onEraseEndRef.current();
        }
        if (touchStateRef.current.type === 'node-drag') {
          setDraggingNodeId(null);
          if (onNodeDragEnd) onNodeDragEnd();
          // Tap on node (no drag movement): select it, tap again -> edit
          if (!touchStateRef.current.moved) {
            const nodeId = touchStateRef.current.nodeId;
            // If already selected, start editing — programmatically focus the text
            if (selectedIdRef.current === nodeId) {
              setEditingNodeId(nodeId);
              editingRef.current = nodeId;
              // Focus the contentEditable text to open keyboard
              const nodeEl = nodeElsRef.current[nodeId];
              if (nodeEl) {
                const textEl = nodeEl.querySelector('.node-text');
                if (textEl) textEl.focus();
              }
            } else {
              onSelect(nodeId, 'node');
            }
          }
        }
        if (touchStateRef.current.type === 'selectionDrag') {
          if (onSelectionDragEnd) onSelectionDragEnd();
        }
        if (touchStateRef.current.type === 'rectSelect') {
          setSelectRect(null);
          if (!touchStateRef.current.moved) {
            // Simple tap on background: deselect
            onSelect(null, null);
            onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
          }
        }
        if (touchStateRef.current.type === 'arrow-preview') {
          const prev = arrowPreviewRef.current;
          setArrowPreview(null);
          if (prev) {
            const fromEndpoint = prev.fromPillArrowId
              ? { pillArrowId: prev.fromPillArrowId, anchor: prev.fromAnchor }
              : { nodeId: prev.fromNodeId, anchor: prev.fromAnchor };
            if (prev.snapPillArrowId) {
              onAddArrow(fromEndpoint, { pillArrowId: prev.snapPillArrowId, anchor: prev.snapPillAnchor });
            } else if (prev.snapNodeId && prev.snapAnchor) {
              onAddArrow(fromEndpoint, { nodeId: prev.snapNodeId, anchor: prev.snapAnchor });
            } else if (prev.cursorX !== undefined && prev.cursorY !== undefined) {
              const fromNode = nodesRef.current[prev.fromNodeId];
              if (fromNode) {
                const fromPos = getAnchorPos(fromNode, prev.fromAnchor, nodeHeightRef.current);
                const dx = prev.cursorX - fromPos.x;
                const dy = prev.cursorY - fromPos.y;
                if (Math.hypot(dx, dy) >= 24) {
                  const toAnchor = Math.abs(dx) > Math.abs(dy)
                    ? (dx > 0 ? 'left' : 'right')
                    : (dy > 0 ? 'top' : 'bottom');
                  const NEW_W = NEW_NODE_W;
                  const NEW_H = NEW_NODE_H;
                  let nx, ny;
                  if (toAnchor === 'left')        { nx = prev.cursorX;             ny = prev.cursorY - NEW_H / 2; }
                  else if (toAnchor === 'right')  { nx = prev.cursorX - NEW_W;     ny = prev.cursorY - NEW_H / 2; }
                  else if (toAnchor === 'top')    { nx = prev.cursorX - NEW_W / 2; ny = prev.cursorY; }
                  else                            { nx = prev.cursorX - NEW_W / 2; ny = prev.cursorY - NEW_H; }
                  nx = snap(nx); ny = snap(ny);
                  const newNodeId = onAddNode(nx, ny);
                  if (newNodeId) {
                    onAddArrow(fromEndpoint, { nodeId: newNodeId, anchor: toAnchor });
                  }
                }
              }
            }
          }
        }
        if (touchStateRef.current.type === 'pan' && !touchStateRef.current.moved) {
          onSelect(null, null);
        }
        touchStateRef.current = null;
      } else if (e.touches.length === 1 && touchStateRef.current.type === 'pinch') {
        const t = e.touches[0];
        touchStateRef.current = { type: 'pan', lastX: t.clientX, lastY: t.clientY, startX: t.clientX, startY: t.clientY, moved: false };
      }
    }

    function onTouchCancel(e) {
      // For erase mode, ignore cancel — DOM mutations from deleting nodes can
      // trigger touchcancel, but we want to keep erasing on continued touch.
      if (touchStateRef.current && touchStateRef.current.type === 'erase') return;
      onTouchEnd(e);
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchCancel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [isMobile, onUpdateViewport, onUpdateNode, onAddStroke, onAddArrow, onAddNode, onSelect, onNodeDragEnd, onSelectionDragEnd, onMoveSelection, onSelectionChange, screenToWorld]);

  /* ================================================================
     Mouse down on canvas background -> pan, draw, erase, or rect select
     ================================================================ */
  // Keep refs to current tool props for event handlers
  const toolModeRef = useRef(toolMode);
  useEffect(() => { toolModeRef.current = toolMode; }, [toolMode]);
  const eraserModeRef = useRef(eraserMode);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  const eraserTargetRef = useRef(eraserTarget);
  useEffect(() => { eraserTargetRef.current = eraserTarget; }, [eraserTarget]);
  const onAddSpaceRef = useRef(onAddSpace);
  useEffect(() => { onAddSpaceRef.current = onAddSpace; }, [onAddSpace]);
  const eraserRadiusRef = useRef(eraserRadius);
  useEffect(() => { eraserRadiusRef.current = eraserRadius; }, [eraserRadius]);
  const drawStrokesRef = useRef(drawStrokes);
  useEffect(() => { drawStrokesRef.current = drawStrokes; }, [drawStrokes]);

  /* ---- Eraser perform ref (set below, used in event handlers) ---- */
  const performEraseRef = useRef(null);
  const onUpdateRegionRef = useRef(onUpdateRegion);
  useEffect(() => { onUpdateRegionRef.current = onUpdateRegion; }, [onUpdateRegion]);
  const onLassoEndRef = useRef(onLassoEnd);
  useEffect(() => { onLassoEndRef.current = onLassoEnd; }, [onLassoEnd]);
  const onEraseEndRef = useRef(onEraseEnd);
  useEffect(() => { onEraseEndRef.current = onEraseEnd; }, [onEraseEnd]);
  const onUpdateStrokeRef = useRef(onUpdateStroke);
  useEffect(() => { onUpdateStrokeRef.current = onUpdateStroke; }, [onUpdateStroke]);
  const onRegionDragEndRef = useRef(onRegionDragEnd);
  useEffect(() => { onRegionDragEndRef.current = onRegionDragEnd; }, [onRegionDragEnd]);
  const onUpdateArrowLiveRef = useRef(onUpdateArrowLive);
  useEffect(() => { onUpdateArrowLiveRef.current = onUpdateArrowLive; }, [onUpdateArrowLive]);

  const onCanvasMouseDown = useCallback((e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const isBackground = e.target === rootRef.current || e.target.classList.contains('canvas-grid') || e.target.classList.contains('canvas-transform') || e.target.classList.contains('drawing-layer') || e.target.classList.contains('eraser-hit-layer') || e.target.classList.contains('select-hit-layer');

    if (!isBackground) return;

    // Clicking the empty canvas ends a node text edit. The handlers below
    // preventDefault (which would keep focus — and the uncommitted text — in
    // the node), so blur explicitly: onTextBlur saves the text.
    const ae = document.activeElement;
    if (ae && ae.isContentEditable && ae.classList.contains('node-text')) ae.blur();

    const rect = rootRef.current.getBoundingClientRect();
    const mx = (activePenPos ? activePenPos.x : e.clientX) - rect.left;
    const my = (activePenPos ? activePenPos.y : e.clientY) - rect.top;
    const world = screenToWorld(mx, my);

    if (toolMode === 'lasso') {
      e.preventDefault();
      onSelect(null, null);
      onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
      dragState.current = { type: 'lasso', points: [world] };
      return;
    }

    if (toolMode === 'space') {
      // Add space: drag down from here to push everything below further down
      // (drag up to close a gap).
      e.preventDefault();
      dragState.current = { type: 'space', y0: snap(world.y), dy: 0 };
      paintSpaceBand(snap(world.y), 0);
      return;
    }

    if (toolMode === 'arrow') {
      // Free-floating arrow: drag from this empty point to another.
      e.preventDefault();
      dragState.current = { type: 'arrowFree', startX: world.x, startY: world.y };
      setFreeArrow({ fromX: world.x, fromY: world.y, toX: world.x, toY: world.y, snapNodeId: null, snapAnchor: null, snapRegionId: null });
      return;
    }

    if (toolMode === 'node' || toolMode === 'region' || toolMode === 'figure') {
      // Placement tools: click for a default-size object, or drag a box.
      e.preventDefault();
      dragState.current = { type: 'place', kind: toolMode, startX: world.x, startY: world.y };
      setPlacePreview({ kind: toolMode, x: world.x, y: world.y, w: 0, h: 0 });
      return;
    }

    if (toolMode === 'draw' && drawFlat && textSnap && pdf && pdf.textNow && docLayoutRef.current) {
      // Highlighter that lands on the text of a PDF page marks the text itself.
      const lay = docLayoutRef.current;
      const pg = lay.pages[Math.min(lay.count - 1, pageOfY(lay, world.y))];
      const text = pg && pg.bg && world.y >= pg.y && world.y <= pg.y + pg.h ? pdf.textNow(pg.bg.src, pg.bg.page) : null;
      if (text && text.chars.length) {
        const pl = pdfPlacement(pg, text);
        const hit = nearestChar(text, (world.x - pl.ox) / pl.s, (world.y - pl.oy) / pl.s);
        const c = text.chars[hit.index];
        if (c && hit.dist < (c.bot - c.top) * 0.8) {
          e.preventDefault();
          dragState.current = { type: 'textHl', text, pl, a: hit.index, b: hit.index, color: drawColor || '#ffd43b', opacity: drawOpacity == null ? 35 : drawOpacity };
          setTextSel(textRange(text, hit.index, hit.index).rects.map((r) => ({ x: pl.ox + r.x0 * pl.s, y: pl.oy + r.top * pl.s, w: (r.x1 - r.x0) * pl.s, h: (r.bot - r.top) * pl.s })));
          return;
        }
      }
    }

    if (toolMode === 'draw') {
      // Start freehand drawing
      e.preventDefault();
      currentStroke.current = { points: [penPoint(world.x, world.y)], color: drawColor || '#cf7bf0', width: drawWidth || 2, opacity: drawOpacity == null ? 100 : drawOpacity, ...(activeTouchInput && activePenPressure == null ? { sl: STREAMLINE_PRECISE } : {}), ...(drawFlat ? { hl: true } : {}), ...(drawStraight ? { shape: 'line' } : {}) };
      dragState.current = { type: 'draw' };
      touchHold(e.clientX, e.clientY);
      setDrawingPreview(gelStrokePath(currentStroke.current.points, currentStroke.current.width, currentStroke.current.shape, currentStroke.current.sl, currentStroke.current.hl));
      return;
    }

    if (toolMode === 'eraser') {
      e.preventDefault();
      dragState.current = { type: 'erase' };
      setEraserCursor(world);
      // Perform initial erase at click position
      if (performEraseRef.current) performEraseRef.current(world.x, world.y);
      return;
    }

    // Move mode: always pan
    if (toolMode === 'move') {
      e.preventDefault();
      rootRef.current?.classList.add('panning');
      dragState.current = {
        type: 'pan',
        startX: mx,
        startY: my,
        startPanX: vpRef.current.panX,
        startPanY: vpRef.current.panY,
      };
      return;
    }

    // Select mode: check if clicking on empty space -> start rect selection or pan
    if (toolMode === 'select') {
      // Check if click is inside selection bounding box (for stroke-only selection drag)
      const sel = selection;
      const selBounds = getSelectionBounds(sel, nodesRef.current, drawStrokesRef.current, nodeHeightRef.current);
      if ((sel.nodeIds.size > 0 || sel.strokeIds.size > 0) && selBounds &&
          world.x >= selBounds.x && world.x <= selBounds.x + selBounds.w &&
          world.y >= selBounds.y && world.y <= selBounds.y + selBounds.h) {
        e.preventDefault();
        dragState.current = {
          type: 'selectionDrag',
          startWorldX: world.x,
          startWorldY: world.y,
          lastWorldX: world.x,
          lastWorldY: world.y,
        };
        return;
      }

      // Clear selection and single-select
      onSelect(null, null);
      onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });

      if (selectFree) { // lasso
        e.preventDefault();
        dragState.current = { type: 'lasso', points: [world] };
        return;
      }

      // Start rectangle selection
      e.preventDefault();
      dragState.current = {
        type: 'rectSelect',
        startWorld: world,
        startScreen: { x: mx, y: my },
        startPanX: vpRef.current.panX,
        startPanY: vpRef.current.panY,
        moved: false,
      };
      return;
    }
  }, [onSelect, toolMode, drawColor, drawWidth, drawOpacity, drawFlat, drawStraight, screenToWorld, onSelectionChange, selection, selectFree, textSnap, pdf]);

  /* ================================================================
     Eraser perform helper
     ================================================================ */
  const performErase = useCallback((wx, wy) => {
    // Convert screen-pixel radius to world units
    const radius = eraserRadiusRef.current / vpRef.current.zoom;
    const mode = eraserModeRef.current;
    const target = eraserTargetRef.current;
    const inkOk = (st) => target === 'all' || target === 'ink' || (target === 'hl' ? !!st.hl : !st.hl);

    if (mode === 'object') {
      const currentNodes = nodesRef.current;
      const currentArrows = arrowsRef.current;
      const currentStrokes = drawStrokesRef.current || [];
      const hm = nodeHeightRef.current;

      const hitNodeIds = [];
      const hitArrowIds = [];
      const hitStrokeIds = [];

      if (target === 'all') {
        for (const node of Object.values(currentNodes)) {
          if (nodeHitsCircle(node, wx, wy, radius, hm)) {
            hitNodeIds.push(node.id);
          }
        }
        for (const [aId, arrow] of Object.entries(currentArrows)) {
          if (arrowHitsCircle(arrow, currentNodes, wx, wy, radius, hm)) {
            hitArrowIds.push(aId);
          }
        }
      }
      for (const stroke of currentStrokes) {
        if (inkOk(stroke) && !strokeFarFrom(stroke, wx, wy, radius) && strokeHitsCircle(stroke, wx, wy, radius)) {
          hitStrokeIds.push(stroke.id);
        }
      }

      if (hitNodeIds.length || hitArrowIds.length || hitStrokeIds.length) {
        onEraseObjects({ nodeIds: hitNodeIds, arrowIds: hitArrowIds, strokeIds: hitStrokeIds });
      }
    } else {
      // Pixel erase
      const currentStrokes = drawStrokesRef.current || [];
      const { strokes: newStrokes, changed } = pixelEraseStrokes(currentStrokes, wx, wy, radius, target === 'all' || target === 'ink' ? null : inkOk);
      if (changed) {
        onPixelErase(newStrokes);
      }
    }
  }, [onEraseObjects, onPixelErase]);

  performEraseRef.current = performErase;

  /* ================================================================
     Mouse down on a node -> start dragging it (or selection drag)
     ================================================================ */
  const onNodeMouseDown = useCallback((e, nodeId) => {
    if (e.button !== 0) return;
    if (e.target.classList.contains('node-text') && e.target.contentEditable === 'true') return;
    if (toolMode === 'eraser') return; // Don't drag in eraser mode
    // Move tool only pans the viewport — nodes are not interactive there.
    if (toolMode === 'move') {
      e.stopPropagation();
      const rect = rootRef.current.getBoundingClientRect();
      rootRef.current?.classList.add('panning');
      dragState.current = {
        type: 'pan',
        startX: e.clientX - rect.left, startY: e.clientY - rect.top,
        startPanX: vpRef.current.panX, startPanY: vpRef.current.panY,
      };
      return;
    }
    e.stopPropagation();

    // Shift-click: toggle this node in/out of the multi-selection (no drag).
    if (e.shiftKey && onToggleSelect) { onToggleSelect(nodeId, 'node'); return; }

    // Alt-drag: leave the original where it is and drag a copy.
    if (e.altKey && onAltDuplicate && toolMode === 'select') {
      onAltDuplicate('node', nodeId);
      const r = rootRef.current.getBoundingClientRect();
      const w0 = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      dragState.current = { type: 'selectionDrag', startWorldX: w0.x, startWorldY: w0.y, lastWorldX: w0.x, lastWorldY: w0.y };
      return;
    }

    // If this node is part of a multi-selection, start group drag
    if (selection.nodeIds.has(nodeId) && selection.nodeIds.size > 0) {
      const rect = rootRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const world = screenToWorld(mx, my);
      dragState.current = {
        type: 'selectionDrag',
        startWorldX: world.x,
        startWorldY: world.y,
        lastWorldX: world.x,
        lastWorldY: world.y,
      };
      return;
    }

    onSelect(nodeId, 'node');
    // Clear rect selection when clicking individual node
    onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    const node = nodes[nodeId];
    if (!node) return;
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    // Pre-compute affected arrows in topological order (parents first):
    //  level 0: arrows directly attached to this node
    //  level 1: arrows whose endpoint is a pill of a level-0 arrow
    //  ...and so on, transitively.
    // The list is consumed in order during mousemove so dependents see
    // up-to-date midpoints from their parents.
    const affectedArrows = [];
    const seen = new Set();
    let frontier = [];
    for (const aId of Object.keys(arrows)) {
      const a = arrows[aId];
      if (a.fromNodeId === nodeId || a.toNodeId === nodeId) {
        frontier.push(aId); seen.add(aId); affectedArrows.push(aId);
      }
    }
    while (frontier.length) {
      const next = [];
      for (const aId of Object.keys(arrows)) {
        if (seen.has(aId)) continue;
        const a = arrows[aId];
        if ((a.fromPillArrowId && seen.has(a.fromPillArrowId)) ||
            (a.toPillArrowId   && seen.has(a.toPillArrowId))) {
          next.push(aId); seen.add(aId); affectedArrows.push(aId);
        }
      }
      frontier = next;
    }
    dragState.current = {
      type: 'node',
      nodeId,
      offsetX: world.x - node.x,
      offsetY: world.y - node.y,
      affectedArrows,
    };
    setDraggingNodeId(nodeId);
  }, [nodes, arrows, onSelect, screenToWorld, toolMode, selection, onSelectionChange, onToggleSelect, onAltDuplicate]);

  /* ================================================================
     Mouse down on an arrow's midpoint pill -> start arrow creation
     from that pill (the typed arrow becomes a connection junction).
     ================================================================ */
  const onPillAnchorMouseDown = useCallback((e, arrowId, anchor) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    dragState.current = {
      type: 'arrow',
      fromPillArrowId: arrowId,
      fromAnchor: anchor,
    };
    setArrowPreview({
      fromPillArrowId: arrowId,
      fromAnchor: anchor,
      cursorX: world.x,
      cursorY: world.y,
      snapNodeId: null,
      snapAnchor: null,
      snapPillArrowId: null,
    });
  }, [screenToWorld]);

  /* ================================================================
     Mouse down on an anchor dot -> start arrow creation
     ================================================================ */
  const onAnchorMouseDown = useCallback((e, nodeId, anchor) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    dragState.current = {
      type: 'arrow',
      fromNodeId: nodeId,
      fromAnchor: anchor,
    };
    setArrowPreview({
      fromNodeId: nodeId,
      fromAnchor: anchor,
      cursorX: world.x,
      cursorY: world.y,
      snapNodeId: null,
      snapAnchor: null,
    });
  }, [screenToWorld]);

  /* ================================================================
     Mouse down on a bezier control handle -> reshape the arrow curve.
     `end` is 'from' or 'to'. The handle stores its position as an offset
     relative to the endpoint (so it survives node movement).
     ================================================================ */
  const onArrowHandleMouseDown = useCallback((e, arrowId, end) => {
    e.stopPropagation();
    e.preventDefault();
    dragState.current = { type: 'arrowHandle', arrowId, end, moved: false };
  }, []);

  // Double-click a handle -> reset that side back to the auto curve.
  const onArrowHandleDoubleClick = useCallback((e, arrowId, end) => {
    e.stopPropagation();
    e.preventDefault();
    const key = end === 'from' ? 'fromCtrl' : 'toCtrl';
    onUpdateArrow(arrowId, { [key]: null });
    onNodeDragEnd();
  }, [onUpdateArrow, onNodeDragEnd]);

  /* ================================================================
     Mouse down on a region's side-midpoint anchor -> start arrow
     ================================================================ */
  const onRegionAnchorMouseDown = useCallback((e, regionId, anchor) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    dragState.current = {
      type: 'arrow',
      fromRegionId: regionId,
      fromAnchor: anchor,
    };
    setArrowPreview({
      fromRegionId: regionId,
      fromAnchor: anchor,
      cursorX: world.x,
      cursorY: world.y,
      snapNodeId: null,
      snapAnchor: null,
      snapRegionId: null,
    });
  }, [screenToWorld]);

  /* ================================================================
     Mouse down on region border -> drag or resize region
     ================================================================ */
  const onRegionBorderMouseDown = useCallback((e, regionId) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Move tool only pans — it never drags regions. (Regions move via the
    // select tool, like nodes.)
    if (toolMode === 'move') {
      const rect = rootRef.current.getBoundingClientRect();
      rootRef.current?.classList.add('panning');
      dragState.current = {
        type: 'pan',
        startX: e.clientX - rect.left, startY: e.clientY - rect.top,
        startPanX: vpRef.current.panX, startPanY: vpRef.current.panY,
      };
      return;
    }
    if (e.shiftKey && onToggleSelect) { onToggleSelect(regionId, 'region'); return; }
    onSelect(regionId, 'region');
    const region = regions[regionId];
    if (!region) return;
    const rect = rootRef.current.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    // Find all objects inside this region's bounds
    const currentNodes = nodesRef.current;
    const currentRegions = regions;
    const containedNodes = [];
    const containedRegions = [];
    for (const n of Object.values(currentNodes)) {
      if (n.x >= region.x && n.y >= region.y &&
          n.x + (n.width || 220) <= region.x + region.w &&
          n.y + (n.height || 60) <= region.y + region.h) {
        containedNodes.push({ id: n.id, dx: n.x - region.x, dy: n.y - region.y });
      }
    }
    for (const r of Object.values(currentRegions)) {
      if (r.id !== regionId && r.x >= region.x && r.y >= region.y &&
          r.x + r.w <= region.x + region.w && r.y + r.h <= region.y + region.h) {
        containedRegions.push({ id: r.id, dx: r.x - region.x, dy: r.y - region.y });
      }
    }
    // Pen strokes fully inside the region — move them too. Snapshot their
    // original points so we can shift by an absolute delta each mousemove.
    const containedStrokes = [];
    for (const s of (drawStrokesRef.current || [])) {
      if (!s.points || s.points.length === 0) continue;
      const inside = s.points.every(p =>
        p.x >= region.x && p.x <= region.x + region.w &&
        p.y >= region.y && p.y <= region.y + region.h);
      if (inside) containedStrokes.push({ id: s.id, points: s.points });
    }

    dragState.current = {
      type: 'regionDrag', regionId,
      offsetX: world.x - region.x, offsetY: world.y - region.y,
      startRegX: region.x, startRegY: region.y,
      containedNodes, containedRegions, containedStrokes,
    };
  }, [regions, onSelect, screenToWorld, toolMode, onToggleSelect]);

  const onRegionResizeMouseDown = useCallback((e, regionId, corner) => {
    e.stopPropagation();
    e.preventDefault();
    const region = regions[regionId];
    if (!region) return;
    dragState.current = { type: 'regionResize', regionId, corner, startX: region.x, startY: region.y, startW: region.w, startH: region.h, startMouseX: e.clientX, startMouseY: e.clientY };
  }, [regions]);

  /* ================================================================
     Mouse down on a resize handle -> start resizing node
     ================================================================ */
  const onResizeMouseDown = useCallback((e, nodeId, corner) => {
    e.stopPropagation();
    e.preventDefault();
    const node = nodes[nodeId];
    if (!node) return;
    dragState.current = {
      type: 'resize',
      nodeId,
      corner, // 'se' | 'sw' | 'ne' | 'nw'
      startX: node.x,
      startY: node.y,
      startW: node.width || 220,
      startH: snap(nodeHeightRef.current[nodeId] || 60),
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      // Square & circle stay 1:1 while resizing.
      lockAspect: node.shape === 'square' || node.shape === 'circle',
      // An image keeps its proportions.
      ratio: node.shape === 'image' ? (node.width || 220) / Math.max(1, node.height || nodeHeightRef.current[nodeId] || 60) : 0,
    };
  }, [nodes]);

  /* ================================================================
     Global mousemove / mouseup
     ================================================================ */
  // We need stable refs to state for use in the mousemove handler
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  const arrowsRef = useRef(arrows);
  useEffect(() => { arrowsRef.current = arrows; }, [arrows]);
  const regionsRef = useRef(regions);
  useEffect(() => { regionsRef.current = regions; }, [regions]);

  useEffect(() => {
    function onMouseMove(e) {
      const ds = dragState.current;

      // Update eraser cursor position even when not dragging
      if (toolModeRef.current === 'eraser' && rootRef.current) {
        const rect = rootRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const vp = vpRef.current;
        setEraserCursor({
          x: (mx - vp.panX) / vp.zoom,
          y: (my - vp.panY) / vp.zoom,
        });
      }

      if (!ds) return;

      const rect = rootRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (ds.type === 'draw') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        if (currentStroke.current) {
          touchHold(e.clientX, e.clientY);
          appendStrokePoint(currentStroke.current, worldX, worldY, modsOf(e));
          setDrawingPreview(gelStrokePath(currentStroke.current.points, currentStroke.current.width, currentStroke.current.shape, currentStroke.current.sl, currentStroke.current.hl));
        }
        return;
      }

      if (ds.type === 'place') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        let x = Math.min(ds.startX, worldX), y = Math.min(ds.startY, worldY);
        let w = Math.abs(worldX - ds.startX), h = Math.abs(worldY - ds.startY);
        // square / circle keep 1:1 while dragging.
        if (ds.kind === 'figure' && (figureShapeRef.current === 'square' || figureShapeRef.current === 'circle')) {
          const s = Math.max(w, h);
          x = worldX < ds.startX ? ds.startX - s : ds.startX;
          y = worldY < ds.startY ? ds.startY - s : ds.startY;
          w = s; h = s;
        }
        setPlacePreview({ kind: ds.kind, x, y, w, h });
        return;
      }

      if (ds.type === 'arrowFree') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const currentNodes = nodesRef.current;
        const currentRegions = regionsRef.current;
        const hm = nodeHeightRef.current;
        const SNAP_DIST = 30;
        let snapNodeId = null, snapAnchor = null, snapRegionId = null;
        for (const nid of Object.keys(currentNodes)) {
          const { anchor, dist } = closestAnchor(currentNodes[nid], worldX, worldY, hm);
          if (dist < SNAP_DIST) { snapNodeId = nid; snapAnchor = anchor; break; }
        }
        if (!snapNodeId) {
          for (const rid of Object.keys(currentRegions)) {
            const r = currentRegions[rid];
            let bestA = null, bestD = Infinity;
            for (const an of ANCHORS) {
              const p = getRegionAnchorPos(r, an);
              const d = Math.hypot(worldX - p.x, worldY - p.y);
              if (d < bestD) { bestD = d; bestA = an; }
            }
            if (bestD < SNAP_DIST) { snapRegionId = rid; snapAnchor = bestA; break; }
          }
        }
        setFreeArrow({ fromX: ds.startX, fromY: ds.startY, toX: worldX, toY: worldY, snapNodeId, snapAnchor, snapRegionId });
        return;
      }

      if (ds.type === 'erase') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        setEraserCursor({ x: worldX, y: worldY });
        performEraseRef.current(worldX, worldY);
        return;
      }

      if (ds.type === 'rectSelect') {
        ds.moved = true;
        const vp = vpRef.current;
        const currentWorld = {
          x: (mx - vp.panX) / vp.zoom,
          y: (my - vp.panY) / vp.zoom,
        };
        const startWorld = ds.startWorld;
        const rx = Math.min(startWorld.x, currentWorld.x);
        const ry = Math.min(startWorld.y, currentWorld.y);
        const rw = Math.abs(currentWorld.x - startWorld.x);
        const rh = Math.abs(currentWorld.y - startWorld.y);
        setSelectRect({ x: rx, y: ry, w: rw, h: rh });

        // Compute selection
        const selRect = { x: rx, y: ry, w: rw, h: rh };
        const currentNodes = nodesRef.current;
        const currentArrows = arrowsRef.current;
        const currentStrokes = drawStrokesRef.current || [];
        const hm = nodeHeightRef.current;

        const selNodeIds = new Set();
        const selStrokeIds = new Set();
        const selArrowIds = new Set();

        for (const node of Object.values(currentNodes)) {
          const nw = node.width || 220;
          const nh = (hm && hm[node.id]) || 60;
          const nodeRect = { x: node.x, y: node.y, w: nw, h: nh };
          if (rectsOverlap(selRect, nodeRect)) {
            selNodeIds.add(node.id);
          }
        }

        for (const stroke of currentStrokes) {
          if (stroke.points && stroke.points.some(p => p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh)) {
            selStrokeIds.add(stroke.id);
          }
        }

        // Select arrows connected to selected nodes
        for (const [aId, arrow] of Object.entries(currentArrows)) {
          if (selNodeIds.has(arrow.fromNodeId) || selNodeIds.has(arrow.toNodeId)) {
            selArrowIds.add(aId);
          }
        }

        onSelectionChange({ nodeIds: selNodeIds, arrowIds: selArrowIds, strokeIds: selStrokeIds });
        return;
      }

      if (ds.type === 'textHl') {
        const vp = vpRef.current;
        const hit = nearestChar(ds.text, ((mx - vp.panX) / vp.zoom - ds.pl.ox) / ds.pl.s, ((my - vp.panY) / vp.zoom - ds.pl.oy) / ds.pl.s);
        if (hit.index >= 0 && hit.index !== ds.b) {
          ds.b = hit.index;
          const pl = ds.pl;
          setTextSel(textRange(ds.text, ds.a, ds.b).rects.map((r) => ({ x: pl.ox + r.x0 * pl.s, y: pl.oy + r.top * pl.s, w: (r.x1 - r.x0) * pl.s, h: (r.bot - r.top) * pl.s })));
        }
        return;
      }

      if (ds.type === 'selectionDrag') {
        // The displacement (in cells) is magnetised: whole-cell moves stick,
        // everything in between is reachable. `applied` is what the board
        // has been moved by so far.
        const vp = vpRef.current;
        const rawX = (mx - vp.panX) / vp.zoom - ds.startWorldX;
        const rawY = (my - vp.panY) / vp.zoom - ds.startWorldY;
        if (Math.hypot(rawX, rawY) * vp.zoom > 5) ds.far = true;
        const free = e.metaKey || e.ctrlKey; // Ctrl/Cmd: no magnet
        // A group with nodes moves in whole cells; ink alone is magnetic.
        const hard = selectionRef.current.nodeIds.size > 0 || (selectionRef.current.regionIds && selectionRef.current.regionIds.size > 0);
        let tx = hard ? snap(rawX) : (free ? rawX : magnet(rawX));
        let ty = hard ? snap(rawY) : (free ? rawY : magnet(rawY));
        // Shift: lock to the dominant axis (may flip mid-drag, as in Excalidraw).
        if (e.shiftKey) { if (Math.abs(rawX) < Math.abs(rawY)) tx = 0; else ty = 0; }
        const dx = tx - (ds.appliedX || 0);
        const dy = ty - (ds.appliedY || 0);
        if (dx !== 0 || dy !== 0) {
          onMoveSelection(dx, dy);
          ds.appliedX = tx;
          ds.appliedY = ty;
        }
        return;
      }

      if (ds.type === 'space') {
        const vp = vpRef.current;
        ds.dy = snap((my - vp.panY) / vp.zoom) - ds.y0;
        paintSpaceBand(ds.y0, ds.dy);
        return;
      }

      if (ds.type === 'selRotate') {
        // Turn the whole selection about its centre (Shift: 15° steps).
        const vp = vpRef.current;
        const wx = (mx - vp.panX) / vp.zoom, wy = (my - vp.panY) / vp.zoom;
        let ang = Math.atan2(wy - ds.cy, wx - ds.cx) - ds.a0;
        if (e.shiftKey) ang = Math.round(ang / SHIFT_LOCK_ANGLE) * SHIFT_LOCK_ANGLE;
        if (Math.abs(ang - ds.angle) < 0.004) return;
        ds.angle = ang;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const turn = (x, y) => ({ x: ds.cx + (x - ds.cx) * cos - (y - ds.cy) * sin, y: ds.cy + (x - ds.cx) * sin + (y - ds.cy) * cos });
        // Boxes (nodes, pictures) stay upright; they travel round the centre.
        for (const n of ds.nodes) {
          const c = turn(n.x + n.width / 2, n.y + n.height / 2);
          onUpdateNode(n.id, { x: snap(c.x - n.width / 2), y: snap(c.y - n.height / 2) });
        }
        if (onUpdateStrokeRef.current) {
          for (const st of ds.strokes) {
            onUpdateStrokeRef.current(st.id, { points: st.points.map((pt) => { const q = turn(pt.x, pt.y); return { ...pt, x: r2(q.x), y: r2(q.y) }; }) });
          }
        }
        return;
      }

      if (ds.type === 'lasso') {
        const vp = vpRef.current;
        const wx = (mx - vp.panX) / vp.zoom, wy = (my - vp.panY) / vp.zoom;
        const lastPt = ds.points[ds.points.length - 1];
        if (Math.hypot(wx - lastPt.x, wy - lastPt.y) < 3 / vp.zoom) return;
        ds.points.push({ x: wx, y: wy });
        paintLasso(ds.points);
        if (!lassoRAF.current) {
          lassoRAF.current = requestAnimationFrame(() => {
            lassoRAF.current = 0;
            const cur = dragState.current;
            if (!cur || cur.type !== 'lasso') return;
            onSelectionChange(lassoSelect(cur.points, nodesRef.current, arrowsRef.current, drawStrokesRef.current, nodeHeightRef.current));
          });
        }
        return;
      }

      if (ds.type === 'lineEnd') {
        const vp = vpRef.current;
        const pts = ds.points.slice();
        pts[ds.index] = lineEndPoint(pts[1 - ds.index], (mx - vp.panX) / vp.zoom, (my - vp.panY) / vp.zoom, modsOf(e));
        ds.points = pts;
        ds.moved = true;
        if (onUpdateStrokeRef.current) onUpdateStrokeRef.current(ds.strokeId, { points: pts });
        return;
      }

      if (ds.type === 'selResize') {
        // Scale the whole selection uniformly about its top-left corner.
        const vp = vpRef.current;
        const wx = (mx - vp.panX) / vp.zoom;
        const wy = (my - vp.panY) / vp.zoom;
        const b = ds.bounds;
        const sx = b.w > 1 ? (wx - b.x) / b.w : 0;
        const sy = b.h > 1 ? (wy - b.y) / b.h : 0;
        const k = Math.min(10, Math.max(0.1, Math.max(sx, sy)));
        if (Math.abs(k - ds.scale) < 0.004) return;
        ds.scale = k;
        for (const n of ds.nodes) {
          onUpdateNode(n.id, {
            x: snap(b.x + (n.x - b.x) * k), y: snap(b.y + (n.y - b.y) * k),
            width: Math.max(60, snap(n.width * k)), height: Math.max(40, snap(n.height * k)),
            fitWidth: false,
          });
        }
        if (onUpdateStrokeRef.current) {
          for (const st of ds.strokes) {
            onUpdateStrokeRef.current(st.id, {
              points: st.points.map((pt) => ({ ...pt, x: b.x + (pt.x - b.x) * k, y: b.y + (pt.y - b.y) * k })),
              width: Math.max(0.5, Math.round(st.width * k * 100) / 100),
            });
          }
        }
        return;
      }

      if (ds.type === 'pan') {
        // Update transform directly via DOM — no React re-render during pan.
        // This is critical for boards with many KaTeX nodes where React diffing
        // 30+ complex DOM trees per frame causes severe lag.
        writeVp({ ...vpRef.current, panX: ds.startPanX + (mx - ds.startX), panY: ds.startPanY + (my - ds.startY) });
      } else if (ds.type === 'node') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        let rawNX = worldX - ds.offsetX, rawNY = worldY - ds.offsetY;
        // Shift: keep the node on the axis it has moved along the most.
        const n0 = nodesRef.current[ds.nodeId];
        if (e.shiftKey && n0) { if (Math.abs(rawNX - n0.x) < Math.abs(rawNY - n0.y)) rawNX = n0.x; else rawNY = n0.y; }
        // Nodes (and the arrows hanging off them) live on the grid — hard snap.
        const newX = snap(rawNX);
        const newY = snap(rawNY);
        // DOM-direct positioning (immediate visual update for the dragged node)
        const nodeEl = nodeElsRef.current[ds.nodeId];
        if (nodeEl) {
          nodeEl.style.left = newX + 'px';
          nodeEl.style.top = newY + 'px';
        }
        ds.lastX = newX;
        ds.lastY = newY;

        // Update attached arrows imperatively so they follow the node without
        // a React re-render. Iterate in topological order; cache midpoints
        // so pill-referencing arrows can use up-to-date parent geometry.
        if (ds.affectedArrows && ds.affectedArrows.length) {
          const allNodes = nodesRef.current;
          const heights = nodeHeightRef.current;
          const draggedId = ds.nodeId;
          const draggedSnap = { ...allNodes[draggedId], x: newX, y: newY };
          const ahSize = vp.zoom < 0.4 ? 18 : 12;
          // Same geometry as render (pill sides, rotation), with the dragged
          // node at its live position.
          const liveNodes = { ...allNodes, [draggedId]: draggedSnap };
          const resolvePos = (arrow, end) => resolveEndpoint(arrow, end, liveNodes, arrowsRef.current, heights, EDGE_KINDS, regionsRef.current);
          for (const aId of ds.affectedArrows) {
            const a = arrowsRef.current[aId];
            if (!a) continue;
            const from = resolvePos(a, 'from');
            const to   = resolvePos(a, 'to');
            if (!from || !to) continue;
            const { path, cp1x, cp1y, cp2x, cp2y, midX, midY, midAngle } = bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, a.fromCtrl, a.toCtrl);
            const g = arrowGsRef.current[aId];
            if (!g) continue;
            // Both <path> children (hit + visible) get the same `d`
            const paths = g.querySelectorAll(':scope > path');
            const dPath = headedPath({ path }, arrowsModeOf(a, a.kind ? EDGE_KINDS[a.kind] : null), ahSize);
            for (const p of paths) p.setAttribute('d', dPath);
            // Arrowheads: 0, 1 or 2 depending on kind.
            // JSX order is forward-arrowhead first, then back-arrowhead.
            const polygons = g.querySelectorAll('polygon.arrow-marker');
            if (polygons.length >= 1) polygons[0].setAttribute('points', arrowheadPoints(to.x, to.y, cp2x, cp2y, ahSize));
            if (polygons.length >= 2) polygons[1].setAttribute('points', arrowheadPoints(from.x, from.y, cp1x, cp1y, ahSize));
            // Midpoint marker group(s) — both relation-glyph circle and
            // operator text pill live inside <g transform="translate(...)">.
            // Include rotation when the kind opts in to align with curve flow.
            const aKindDef = a.kind ? EDGE_KINDS[a.kind] : null;
            let mt = `translate(${midX} ${midY})`;
            if (aKindDef && aKindDef.rotateWithFlow) mt += ` rotate(${snapAngle(midAngle)})`;
            const midGroups = g.querySelectorAll(':scope > g');
            for (const mg of midGroups) mg.setAttribute('transform', mg.classList.contains('arrow-not') ? `translate(${midX} ${midY})` : mt);
            const fo = g.querySelector(':scope > foreignObject');
            if (fo) {
              fo.setAttribute('x', midX - 84);
              fo.setAttribute('y', midY - 30);
            }
          }
        }
      } else if (ds.type === 'arrowHandle') {
        // Imperative DOM update (no React re-render per move — same approach
        // as node drag). State is committed once on mouseup.
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const a = arrowsRef.current[ds.arrowId];
        if (a) {
          const allNodes = nodesRef.current;
          const heights = nodeHeightRef.current;
          const from = resolveEndpoint(a, 'from', allNodes, arrowsRef.current, heights, EDGE_KINDS, regionsRef.current);
          const to   = resolveEndpoint(a, 'to',   allNodes, arrowsRef.current, heights, EDGE_KINDS, regionsRef.current);
          if (from && to) {
            const endpoint = ds.end === 'from' ? from : to;
            const ctrl = { dx: worldX - endpoint.x, dy: worldY - endpoint.y };
            ds.moved = true;
            ds.ctrl = ctrl;
            // Use the new ctrl for the dragged side, committed ctrl for the other.
            const fromCtrl = ds.end === 'from' ? ctrl : a.fromCtrl;
            const toCtrl   = ds.end === 'to'   ? ctrl : a.toCtrl;
            const { path, cp1x, cp1y, cp2x, cp2y, midX, midY, midAngle } =
              bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, fromCtrl, toCtrl);
            const ahSize = vp.zoom < 0.4 ? 18 : 12;
            // Redraw the arrow's own <g> (paths, arrowheads, midpoint marker).
            const g = arrowGsRef.current[ds.arrowId];
            if (g) {
              const paths = g.querySelectorAll(':scope > path');
              const aKindDef = a.kind ? EDGE_KINDS[a.kind] : null;
              const dPath = headedPath({ path }, arrowsModeOf(a, aKindDef), ahSize);
              for (const p of paths) p.setAttribute('d', dPath);
              const polygons = g.querySelectorAll('polygon.arrow-marker');
              if (polygons.length >= 1) polygons[0].setAttribute('points', arrowheadPoints(to.x, to.y, cp2x, cp2y, ahSize));
              if (polygons.length >= 2) polygons[1].setAttribute('points', arrowheadPoints(from.x, from.y, cp1x, cp1y, ahSize));
              let mt = `translate(${midX} ${midY})`;
              if (aKindDef && aKindDef.rotateWithFlow) mt += ` rotate(${snapAngle(midAngle)})`;
              const midGroups = g.querySelectorAll(':scope > g');
              for (const mg of midGroups) mg.setAttribute('transform', mg.classList.contains('arrow-not') ? `translate(${midX} ${midY})` : mt);
              const fo = g.querySelector(':scope > foreignObject');
              if (fo) { fo.setAttribute('x', midX - 84); fo.setAttribute('y', midY - 30); }
            }
            // Move the handle overlay (leashes + control circles).
            const hg = arrowHandlesGRef.current;
            if (hg) {
              const lines = hg.querySelectorAll('line.arrow-handle-leash');
              const circles = hg.querySelectorAll('circle.arrow-handle');
              if (lines[0]) { lines[0].setAttribute('x2', cp1x); lines[0].setAttribute('y2', cp1y); }
              if (lines[1]) { lines[1].setAttribute('x2', cp2x); lines[1].setAttribute('y2', cp2y); }
              if (circles[0]) { circles[0].setAttribute('cx', cp1x); circles[0].setAttribute('cy', cp1y); }
              if (circles[1]) { circles[1].setAttribute('cx', cp2x); circles[1].setAttribute('cy', cp2y); }
            }
          }
        }
      } else if (ds.type === 'arrow') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const currentNodes = nodesRef.current;
        const currentArrows = arrowsRef.current;
        const hm = nodeHeightRef.current;
        let snapNodeId = null;
        let snapAnchor = null;
        let snapPillArrowId = null;
        let snapPillAnchor = null;
        let snapRegionId = null;
        const currentRegions = regionsRef.current;
        const SNAP_DIST = 30;
        // Pill snap takes priority — pills are smaller and more specific.
        for (const aId of Object.keys(currentArrows)) {
          if (aId === ds.fromPillArrowId) continue;        // can't connect to own source pill
          const a = currentArrows[aId];
          if (!a.kind) continue;                            // only typed arrows have pills
          const f = resolveEndpoint(a, 'from', currentNodes, currentArrows, hm, EDGE_KINDS, regionsRef.current);
          const t = resolveEndpoint(a, 'to',   currentNodes, currentArrows, hm, EDGE_KINDS, regionsRef.current);
          if (!f || !t) continue;
          const { midX, midY } = bezierPath(f.x, f.y, f.anchor, t.x, t.y, t.anchor, a.fromCtrl, a.toCtrl);
          const b = getPillBounds(a, EDGE_KINDS);
          if (!b) continue;
          // Find closest of the 4 cardinal anchors on the pill border.
          let bestA = null, bestD = Infinity;
          for (const an of ANCHORS) {
            let ax = midX, ay = midY;
            if (an === 'top') ay -= b.halfH;
            else if (an === 'bottom') ay += b.halfH;
            else if (an === 'left') ax -= b.halfW;
            else if (an === 'right') ax += b.halfW;
            const d = Math.hypot(worldX - ax, worldY - ay);
            if (d < bestD) { bestD = d; bestA = an; }
          }
          if (bestD < SNAP_DIST) {
            snapPillArrowId = aId;
            snapPillAnchor = bestA;
            break;
          }
        }
        if (!snapPillArrowId) {
          for (const nid of Object.keys(currentNodes)) {
            if (nid === ds.fromNodeId) continue;
            const { anchor, dist } = closestAnchor(currentNodes[nid], worldX, worldY, hm);
            if (dist < SNAP_DIST) {
              snapNodeId = nid;
              snapAnchor = anchor;
              break;
            }
          }
          // Fallback: cursor INSIDE a node's bounding box also counts as a
          // snap, with the anchor chosen as the nearest side. Makes drop
          // forgiving — no need to drop precisely on the edge.
          if (!snapNodeId) {
            for (const nid of Object.keys(currentNodes)) {
              if (nid === ds.fromNodeId) continue;
              const n = currentNodes[nid];
              const w = n.width || 220;
              const h = n.height || hm[nid] || 60;
              if (worldX >= n.x && worldX <= n.x + w && worldY >= n.y && worldY <= n.y + h) {
                const dL = worldX - n.x, dR = n.x + w - worldX;
                const dT = worldY - n.y, dB = n.y + h - worldY;
                const m = Math.min(dL, dR, dT, dB);
                snapNodeId = nid;
                snapAnchor = m === dL ? 'left' : m === dR ? 'right' : m === dT ? 'top' : 'bottom';
                break;
              }
            }
          }
          // Region side-midpoint snap — only when nothing else matched.
          if (!snapNodeId) {
            for (const rid of Object.keys(currentRegions)) {
              if (rid === ds.fromRegionId) continue;
              const r = currentRegions[rid];
              let bestA = null, bestD = Infinity;
              for (const an of ANCHORS) {
                const p = getRegionAnchorPos(r, an);
                const d = Math.hypot(worldX - p.x, worldY - p.y);
                if (d < bestD) { bestD = d; bestA = an; }
              }
              if (bestD < SNAP_DIST) {
                snapRegionId = rid;
                snapAnchor = bestA;
                break;
              }
            }
          }
        }
        setArrowPreview({
          fromNodeId:      ds.fromNodeId      || null,
          fromAnchor:      ds.fromAnchor      || null,
          fromPillArrowId: ds.fromPillArrowId || null,
          fromRegionId:    ds.fromRegionId    || null,
          cursorX: worldX,
          cursorY: worldY,
          snapNodeId,
          snapAnchor,
          snapPillArrowId,
          snapPillAnchor,
          snapRegionId,
        });
      } else if (ds.type === 'resize') {
        const vp = vpRef.current;
        const dx = (e.clientX - ds.startMouseX) / vp.zoom;
        const dy = (e.clientY - ds.startMouseY) / vp.zoom;
        const MIN_W = 60;
        const MIN_H = 40;

        let newW = ds.startW;
        let newH = ds.startH;
        let newX = ds.startX;
        let newY = ds.startY;

        if (ds.corner === 'se') {
          newW = snap(Math.max(MIN_W, ds.startW + dx));
          newH = snap(Math.max(MIN_H, ds.startH + dy));
        } else if (ds.corner === 'sw') {
          newW = snap(Math.max(MIN_W, ds.startW - dx));
          newH = snap(Math.max(MIN_H, ds.startH + dy));
          newX = snap(ds.startX + ds.startW - newW);
        } else if (ds.corner === 'ne') {
          newW = snap(Math.max(MIN_W, ds.startW + dx));
          newH = snap(Math.max(MIN_H, ds.startH - dy));
          newY = snap(ds.startY + ds.startH - newH);
        } else if (ds.corner === 'nw') {
          newW = snap(Math.max(MIN_W, ds.startW - dx));
          newH = snap(Math.max(MIN_H, ds.startH - dy));
          newX = snap(ds.startX + ds.startW - newW);
          newY = snap(ds.startY + ds.startH - newH);
        }

        // Aspect lock (square / circle): force a square box, keeping the
        // dragged corner's fixed corner anchored.
        if (ds.lockAspect) {
          const s = Math.max(newW, newH);
          const farR = ds.startX + ds.startW, farB = ds.startY + ds.startH;
          newW = s; newH = s;
          newX = (ds.corner === 'sw' || ds.corner === 'nw') ? farR - s : ds.startX;
          newY = (ds.corner === 'ne' || ds.corner === 'nw') ? farB - s : ds.startY;
        }

        if (ds.ratio) {
          const farR = ds.startX + ds.startW, farB = ds.startY + ds.startH;
          newH = Math.max(20, Math.round(newW / ds.ratio));
          newX = (ds.corner === 'sw' || ds.corner === 'nw') ? farR - newW : ds.startX;
          newY = (ds.corner === 'ne' || ds.corner === 'nw') ? farB - newH : ds.startY;
        }

        onUpdateNode(ds.nodeId, { x: newX, y: newY, width: newW, height: newH });
      } else if (ds.type === 'regionDrag') {
        const vp = vpRef.current;
        const wx = (mx - vp.panX) / vp.zoom;
        const wy = (my - vp.panY) / vp.zoom;
        const newRegX = snap(wx - ds.offsetX);
        const newRegY = snap(wy - ds.offsetY);
        onUpdateRegionRef.current(ds.regionId, { x: newRegX, y: newRegY });
        // Move contained objects with the region
        if (ds.containedNodes) {
          for (const cn of ds.containedNodes) {
            onUpdateNode(cn.id, { x: newRegX + cn.dx, y: newRegY + cn.dy });
          }
        }
        if (ds.containedRegions) {
          for (const cr of ds.containedRegions) {
            onUpdateRegionRef.current(cr.id, { x: newRegX + cr.dx, y: newRegY + cr.dy });
          }
        }
        if (ds.containedStrokes && onUpdateStrokeRef.current) {
          const sdx = newRegX - ds.startRegX, sdy = newRegY - ds.startRegY;
          for (const cs of ds.containedStrokes) {
            onUpdateStrokeRef.current(cs.id, {
              points: cs.points.map(p => ({ ...p, x: p.x + sdx, y: p.y + sdy })),
            });
          }
        }
      } else if (ds.type === 'regionResize') {
        const vp = vpRef.current;
        const dx = (e.clientX - ds.startMouseX) / vp.zoom;
        const dy = (e.clientY - ds.startMouseY) / vp.zoom;
        const MIN_S = 60;
        const farR = ds.startX + ds.startW, farB = ds.startY + ds.startH;
        let newW = ds.startW, newH = ds.startH, newX = ds.startX, newY = ds.startY;
        if (ds.corner === 'se') { newW = snap(Math.max(MIN_S, ds.startW + dx)); newH = snap(Math.max(MIN_S, ds.startH + dy)); }
        else if (ds.corner === 'sw') { newW = snap(Math.max(MIN_S, ds.startW - dx)); newH = snap(Math.max(MIN_S, ds.startH + dy)); newX = farR - newW; }
        else if (ds.corner === 'ne') { newW = snap(Math.max(MIN_S, ds.startW + dx)); newH = snap(Math.max(MIN_S, ds.startH - dy)); newY = farB - newH; }
        else if (ds.corner === 'nw') { newW = snap(Math.max(MIN_S, ds.startW - dx)); newH = snap(Math.max(MIN_S, ds.startH - dy)); newX = farR - newW; newY = farB - newH; }
        onUpdateRegionRef.current(ds.regionId, { x: newX, y: newY, w: newW, h: newH });
      }
    }

    function onMouseUp() {
      const ds = dragState.current;
      if (ds && ds.type === 'place') {
        const p = placePreviewRef.current;
        setPlacePreview(null);
        if (p && onPlaceObjectRef.current) {
          // Default sizes for a plain click (no real drag).
          const DEF = {
            node:   { w: NEW_NODE_W, h: NEW_NODE_H },
            region: { w: 300, h: 200 },
            figure: (figureShapeRef.current === 'rect' || figureShapeRef.current === 'ellipse') ? { w: 200, h: 120 } : { w: 140, h: 140 },
          };
          let { x, y, w, h } = p;
          if ((w < 16 || h < 16) && ds.kind === 'region') { dragState.current = null; return; } // regions are drawn, never clicked into existence
          if (w < 16 || h < 16) {
            const d = DEF[ds.kind];
            w = d.w; h = d.h;
            x = p.x - (w - p.w) / 2; // keep the click roughly centred
            y = p.y - (h - p.h) / 2;
          }
          onPlaceObjectRef.current(ds.kind, figureShapeRef.current, x, y, w, h);
        }
      }
      if (ds && ds.type === 'draw') {
        cancelHold();
        // One point is a dot (the dot of an i, a decimal point) — keep it.
        if (currentStroke.current && currentStroke.current.points.length >= 1 && onAddStroke) {
          onAddStroke({ ...currentStroke.current });
        }
        currentStroke.current = null;
        setDrawingPreview(null);
      }
      if (ds && ds.type === 'arrowFree') {
        const fa = freeArrowRef.current;
        setFreeArrow(null);
        if (fa) {
          const dist = Math.hypot(fa.toX - fa.fromX, fa.toY - fa.fromY);
          if (dist >= 12) {
            // Derive a natural curve direction from the drag vector.
            const dx = fa.toX - fa.fromX, dy = fa.toY - fa.fromY;
            const horiz = Math.abs(dx) > Math.abs(dy);
            const fromAnchor = horiz ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
            const fromEndpoint = { point: { x: fa.fromX, y: fa.fromY }, anchor: fromAnchor };
            let toEndpoint;
            if (fa.snapNodeId && fa.snapAnchor) {
              toEndpoint = { nodeId: fa.snapNodeId, anchor: fa.snapAnchor };
            } else if (fa.snapRegionId && fa.snapAnchor) {
              toEndpoint = { regionId: fa.snapRegionId, anchor: fa.snapAnchor };
            } else {
              const toAnchor = horiz ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'top' : 'bottom');
              toEndpoint = { point: { x: fa.toX, y: fa.toY }, anchor: toAnchor };
            }
            onAddArrow(fromEndpoint, toEndpoint);
          }
        }
      }
      if (ds && ds.type === 'pan') {
        rootRef.current?.classList.remove('panning');
        // Sync React state with the DOM-driven pan position
        onUpdateViewport({ ...vpRef.current });
      }
      if (ds && ds.type === 'node') {
        // Cancel any in-flight RAF commit and flush the final position
        // synchronously so we never lose the last bit of movement.
        if (ds.commitRAF) {
          cancelAnimationFrame(ds.commitRAF);
          ds.commitRAF = null;
        }
        if (ds.lastX !== undefined && (ds.lastX !== ds.committedX || ds.lastY !== ds.committedY)) {
          // The drag is magnetic (free between grid lines); the drop is not.
          const fx = snap(ds.lastX), fy = snap(ds.lastY);
          const nodeEl = nodeElsRef.current[ds.nodeId];
          if (nodeEl) { nodeEl.style.left = fx + 'px'; nodeEl.style.top = fy + 'px'; }
          onUpdateNode(ds.nodeId, { x: fx, y: fy });
        }
        setDraggingNodeId(null);
        onNodeDragEnd();
      }
      if (ds && ds.type === 'lasso') {
        if (lassoRAF.current) { cancelAnimationFrame(lassoRAF.current); lassoRAF.current = 0; }
        const found = lassoSelect(ds.points, nodesRef.current, arrowsRef.current, drawStrokesRef.current, nodeHeightRef.current);
        onSelectionChange(found);
        paintLasso(null);
        if (onLassoEndRef.current) onLassoEndRef.current(found.nodeIds.size + found.strokeIds.size > 0);
      }
      if (ds && ds.type === 'erase') {
        // One undo step for the whole erasing gesture.
        if (onEraseEndRef.current) onEraseEndRef.current();
      }
      if (ds && ds.type === 'space') {
        paintSpaceBand(null);
        if (ds.dy && onAddSpaceRef.current) onAddSpaceRef.current(ds.y0, ds.dy);
      }
      if (ds && ds.type === 'rectSelect') {
        setSelectRect(null);
        // If user didn't move, it was a click on empty space -> already cleared selection
        if (!ds.moved) {
          // Start panning instead
        }
      }
      if (ds && ds.type === 'textHl') {
        setTextSel(null);
        const { rects, text } = textRange(ds.text, ds.a, ds.b);
        const pl = ds.pl;
        const th = `th${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        // One straight highlighter stroke per line of text: they behave like
        // any other ink (erase, select, move with the page) and carry the words.
        const made = rects.map((r) => {
          const h = (r.bot - r.top) * pl.s;
          const y = pl.oy + ((r.top + r.bot) / 2) * pl.s;
          const x0 = pl.ox + r.x0 * pl.s + h / 2;
          const x1 = Math.max(x0 + 0.5, pl.ox + r.x1 * pl.s - h / 2);
          return { points: [{ x: x0, y }, { x: x1, y }], color: ds.color, width: Math.round(h * 10) / 10, opacity: ds.opacity, hl: true, shape: 'line', th, text };
        });
        if (made.length && text) {
          if (onAddStrokesRef.current) onAddStrokesRef.current(made);
        }
      }
      if (ds && ds.type === 'selectionDrag') {
        // Nodes live on the grid: settle the group onto whole cells. Ink alone
        // keeps the (magnetised) position it was dropped at.
        if (selectionRef.current.nodeIds.size > 0 && (ds.appliedX || ds.appliedY)) {
          const fx = snap(ds.appliedX || 0) - (ds.appliedX || 0);
          const fy = snap(ds.appliedY || 0) - (ds.appliedY || 0);
          if (fx !== 0 || fy !== 0) onMoveSelection(fx, fy);
        }
        onSelectionDragEnd();
        // A press without a drag is a click on the selection: its options pop up.
        if (!ds.far && !ds.appliedX && !ds.appliedY && onSelectionTapRef.current) {
          const b = getSelectionBounds(selectionRef.current, nodesRef.current, drawStrokesRef.current, nodeHeightRef.current);
          if (b) onSelectionTapRef.current(b);
        }
      }
      if (ds && (ds.type === 'selResize' || (ds.type === 'selRotate' && ds.angle) || (ds.type === 'lineEnd' && ds.moved))) {
        onSelectionDragEnd();
      }
      if (ds && ds.type === 'resize') {
        // Guarantee the committed geometry is grid-aligned so no fractional
        // height/position can survive a resize (e.g. shrinking a multi-line
        // node by dragging its bottom edge up).
        const n = nodesRef.current[ds.nodeId];
        if (n) {
          const sx = snap(n.x), sy = snap(n.y);
          const sw = Math.max(60, snap(n.width || 220));
          const sh = Math.max(40, snap(n.height || 60));
          if (sx !== n.x || sy !== n.y || sw !== n.width || sh !== n.height || n.fitWidth) {
            onUpdateNode(ds.nodeId, { x: sx, y: sy, width: sw, height: sh, fitWidth: false });
          }
        }
        onNodeDragEnd();
      }
      if (ds && (ds.type === 'regionDrag' || ds.type === 'regionResize')) {
        onRegionDragEndRef.current();
      }
      if (ds && ds.type === 'arrowHandle') {
        // Commit once: set the final control offset (+ websocket send) and
        // push a single history snapshot for the whole drag.
        if (ds.moved && ds.ctrl) {
          const key = ds.end === 'from' ? 'fromCtrl' : 'toCtrl';
          onUpdateArrowLiveRef.current?.(ds.arrowId, { [key]: ds.ctrl });
          onNodeDragEnd();
        }
      }
      if (ds && ds.type === 'arrow') {
        // Read preview from ref + clear state synchronously. Side effects
        // (onAddArrow / onAddNode) MUST run outside the setState updater —
        // React StrictMode invokes pure updaters twice in dev, which would
        // otherwise create duplicate nodes/arrows.
        const prev = arrowPreviewRef.current;
        setArrowPreview(null);
        if (prev) {
          const fromEndpoint = prev.fromPillArrowId
            ? { pillArrowId: prev.fromPillArrowId, anchor: prev.fromAnchor }
            : prev.fromRegionId
              ? { regionId: prev.fromRegionId, anchor: prev.fromAnchor }
              : { nodeId: prev.fromNodeId, anchor: prev.fromAnchor };
          if (prev.snapPillArrowId) {
            onAddArrow(fromEndpoint, { pillArrowId: prev.snapPillArrowId, anchor: prev.snapPillAnchor });
          } else if (prev.snapNodeId && prev.snapAnchor) {
            onAddArrow(fromEndpoint, { nodeId: prev.snapNodeId, anchor: prev.snapAnchor });
          } else if (prev.snapRegionId && prev.snapAnchor) {
            onAddArrow(fromEndpoint, { regionId: prev.snapRegionId, anchor: prev.snapAnchor });
          } else if (prev.cursorX !== undefined && prev.cursorY !== undefined) {
            // Dropped in empty space → spawn a new node at the cursor
            // (grid-aligned) and connect the arrow to it.
            const fromPos = prev.fromPillArrowId
              ? (() => {
                  const a = arrowsRef.current[prev.fromPillArrowId];
                  if (!a) return null;
                  const f = resolveEndpoint(a, 'from', nodesRef.current, arrowsRef.current, nodeHeightRef.current, EDGE_KINDS, regionsRef.current);
                  const t = resolveEndpoint(a, 'to',   nodesRef.current, arrowsRef.current, nodeHeightRef.current, EDGE_KINDS, regionsRef.current);
                  if (!f || !t) return null;
                  const { midX, midY } = bezierPath(f.x, f.y, f.anchor, t.x, t.y, t.anchor, a.fromCtrl, a.toCtrl);
                  return { x: midX, y: midY };
                })()
              : prev.fromRegionId
                ? (regionsRef.current[prev.fromRegionId]
                    ? getRegionAnchorPos(regionsRef.current[prev.fromRegionId], prev.fromAnchor)
                    : null)
                : (nodesRef.current[prev.fromNodeId]
                    ? getAnchorPos(nodesRef.current[prev.fromNodeId], prev.fromAnchor, nodeHeightRef.current)
                    : null);
            if (fromPos) {
              const dx = prev.cursorX - fromPos.x;
              const dy = prev.cursorY - fromPos.y;
              // Require real movement so accidental clicks don't spawn a node.
              if (Math.hypot(dx, dy) >= 24) {
                const toAnchor = Math.abs(dx) > Math.abs(dy)
                  ? (dx > 0 ? 'left' : 'right')
                  : (dy > 0 ? 'top' : 'bottom');
                const NEW_W = NEW_NODE_W;
                const NEW_H = NEW_NODE_H;
                let nx, ny;
                if (toAnchor === 'left')        { nx = prev.cursorX;             ny = prev.cursorY - NEW_H / 2; }
                else if (toAnchor === 'right')  { nx = prev.cursorX - NEW_W;     ny = prev.cursorY - NEW_H / 2; }
                else if (toAnchor === 'top')    { nx = prev.cursorX - NEW_W / 2; ny = prev.cursorY; }
                else                            { nx = prev.cursorX - NEW_W / 2; ny = prev.cursorY - NEW_H; }
                nx = snap(nx); ny = snap(ny);
                const newNodeId = onAddNode(nx, ny);
                if (newNodeId) {
                  onAddArrow(fromEndpoint, { nodeId: newNodeId, anchor: toAnchor });
                }
              }
            }
          }
        }
      }
      dragState.current = null;
      if (panRAF.current) {
        cancelAnimationFrame(panRAF.current);
        panRAF.current = null;
      }
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onUpdateViewport, onUpdateNode, onAddArrow, onAddNode, onAddStroke, onMoveSelection, onSelectionDragEnd, onNodeDragEnd, onSelectionChange, paintLasso]);

  /* ================================================================
     Handle mouse leaving canvas - hide eraser cursor
     ================================================================ */
  const onCanvasMouseLeave = useCallback(() => {
    if (toolMode === 'eraser') {
      setEraserCursor(null);
    }
  }, [toolMode]);

  /* ================================================================
     Double-click on background -> create node
     ================================================================ */
  const onCanvasDoubleClick = useCallback((e) => {
    if (e.target !== rootRef.current && !e.target.classList.contains('canvas-grid') && !e.target.classList.contains('canvas-transform') && !e.target.classList.contains('select-hit-layer')) return;
    const rect = rootRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    onAddNode(snap(world.x - NEW_NODE_W / 2), snap(world.y - NEW_NODE_H / 2));
  }, [screenToWorld, onAddNode]);

  /* ================================================================
     Click on arrow -> select it
     ================================================================ */
  const onArrowClick = useCallback((e, arrowId) => {
    e.stopPropagation();
    if (e.shiftKey && onToggleSelect) { onToggleSelect(arrowId, 'arrow'); return; }
    onSelect(arrowId, 'arrow');
  }, [onSelect, onToggleSelect]);

  /* ================================================================
     Double-click on arrow -> edit label
     ================================================================ */
  const [editingArrowId, setEditingArrowId] = useState(null);

  const onArrowDoubleClick = useCallback((e, arrowId) => {
    e.stopPropagation();
    onSelect(arrowId, 'arrow');
    setEditingArrowId(arrowId);
  }, [onSelect]);

  const onArrowLabelBlur = useCallback((e, arrowId) => {
    const label = e.target.innerText.trim();
    if (onUpdateArrow) onUpdateArrow(arrowId, { label });
    setEditingArrowId(null);
  }, [onUpdateArrow]);

  const onArrowLabelKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      setEditingArrowId(null);
      e.target.blur();
    }
  }, []);

  /* ================================================================
     Node text editing — `editingNodeId` is lifted to App so Vim-mode
     can drive edit start/stop from outside the canvas.
     ================================================================ */
  const editingRef = useRef(null);
  // Per-node vertical centre captured on the first keystroke of an edit, so
  // auto-grow can expand the node symmetrically (up + down) around a fixed
  // point instead of only downward. Cleared on blur.
  const growthCenterRef = useRef({});
  useEffect(() => { editingRef.current = editingNodeId; }, [editingNodeId]);

  // Live LaTeX preview while editing: a small panel under the node that
  // re-renders the text on every keystroke (only when there is any $…$).
  const [editPreview, setEditPreview] = useState(null); // { nodeId, html } | null
  const updateEditPreview = useCallback((nodeId, text) => {
    setEditPreview(text && text.includes('$') ? { nodeId, html: renderRichToHtml(text) } : null);
  }, []);
  useEffect(() => {
    if (!editingNodeId) { setEditPreview(null); return; }
    const n = nodes[editingNodeId];
    updateEditPreview(editingNodeId, n ? n.text : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingNodeId]);

  // When edit mode is entered (via Tab from App), focus the editable text
  // span and place the caret at the end so the very next keystroke types
  // into the node.  If the user clicked the text directly the browser
  // already focused it at the click position — don't override that.
  useEffect(() => {
    if (!editingNodeId) return;
    const wb = nodeElsRef.current[editingNodeId];
    if (!wb) return;
    requestAnimationFrame(() => {
      // Re-query inside RAF: by this point React has rendered the editable
      // span (the LaTeX-rendered span is gone while isEditing is true).
      const wb2 = nodeElsRef.current[editingNodeId];
      if (!wb2) return;
      const span = wb2.querySelector('.node-text');
      if (!span) return;
      if (document.activeElement === span) return; // click already focused
      span.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(span);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }, [editingNodeId]);

  const onTextClick = useCallback((e, nodeId) => {
    // Move tool only pans — don't select or edit nodes through their text.
    if (toolMode === 'move') return;
    e.stopPropagation();
    onSelect(nodeId, 'node');
    setEditingNodeId(nodeId);
    editingRef.current = nodeId;
  }, [onSelect, toolMode]);

  const onTextBlur = useCallback((e, nodeId) => {
    // End of this edit — drop the captured growth centre so the next edit
    // re-anchors from the node's current position.
    delete growthCenterRef.current[nodeId];
    const text = e.target.innerText.trim();
    onUpdateNode(nodeId, { text });
    // Push history after text edit (onUpdateNode doesn't push history)
    if (onNodeDragEnd) onNodeDragEnd();
    if (editingRef.current === nodeId) {
      setEditingNodeId(null);
      editingRef.current = null;
    }
  }, [onUpdateNode, onNodeDragEnd]);

  const onTextKeyDown = useCallback((e, nodeId) => {
    // ⌃ + key → insert a LaTeX connective at the caret (edit mode only).
    // Control (not ⌘) because every one of these is free of OS/browser bindings.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const SNIPPETS = {
        Digit7: '$\\wedge$', Digit8: '$\\vee$', Digit9: '$\\subset$', Digit0: '$\\supset$',
        Period: '$\\Rightarrow$', Comma: '$\\Leftarrow$', Equal: '$\\equiv$', Backquote: '$\\sim$',
      };
      const snippet = SNIPPETS[e.code];
      if (snippet) {
        e.preventDefault(); e.stopPropagation();
        document.execCommand('insertText', false, snippet); // fires `input` → fit/preview update
        return;
      }
    }
    if (e.key === 'Escape') {
      e.target.innerText = nodes[nodeId]?.text || '';
      setEditingNodeId(null);
      editingRef.current = null;
      e.target.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    // Cmd/Ctrl + Enter → exit to dev (handled by the global App handler).
    if (e.metaKey || e.ctrlKey) return;
    // Shift+Enter → keep the browser default (soft line break inside the list item).
    if (e.shiftKey) return;
    // Plain Enter: continue the markdown list at the current caret line.
    const editable = e.target;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editable.contains(range.startContainer)) return;
    // Text from start of editable up to the caret.
    const r = range.cloneRange();
    r.setStart(editable, 0);
    const before = r.toString();
    const lastNl = before.lastIndexOf('\n');
    const lineSoFar = before.slice(lastNl + 1);

    const taskM = lineSoFar.match(/^(\s*)- \[[ xX]\](\s*)(.*)$/);
    const ulM   = lineSoFar.match(/^(\s*)([-*])(\s+)(.*)$/);
    const olM   = lineSoFar.match(/^(\s*)(\d+)\.(\s+)(.*)$/);

    let prefix = null, contentEmpty = false;
    if (taskM) {
      contentEmpty = taskM[3].length === 0;
      prefix = `${taskM[1]}- [ ] `;
    } else if (ulM) {
      contentEmpty = ulM[4].length === 0;
      prefix = `${ulM[1]}${ulM[2]} `;
    } else if (olM) {
      contentEmpty = olM[4].length === 0;
      prefix = `${olM[1]}${parseInt(olM[2], 10) + 1}. `;
    }

    if (prefix && contentEmpty) {
      // Empty marker line → strip the marker, then break to a clean line (exits the list).
      e.preventDefault();
      for (let i = 0; i < lineSoFar.length; i++) document.execCommand('delete');
      document.execCommand('insertText', false, '\n');
      return;
    }
    if (prefix) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n' + prefix);
      return;
    }
    // No list pattern → normalise to a plain newline (browser default in
    // contentEditable varies between <br>, <div>, and <p>; insertText '\n'
    // is consistent and round-trips cleanly via innerText).
    e.preventDefault();
    document.execCommand('insertText', false, '\n');
  }, [nodes]);

  /* ================================================================
     Measure node heights after render
     ================================================================ */
  const nodeElsRef = useRef({});

  const registerNodeEl = useCallback((nodeId, el) => {
    if (el) {
      nodeElsRef.current[nodeId] = el;
    } else {
      delete nodeElsRef.current[nodeId];
    }
  }, []);

  // Imperative refs to arrow <g> elements — used to update arrow geometry
  // during a node drag without triggering a full React re-render.
  const arrowGsRef = useRef({});
  // Ref to the bezier-handle overlay <g>, for imperative updates during drag.
  const arrowHandlesGRef = useRef(null);
  const registerArrowG = useCallback((aId, el) => {
    if (el) arrowGsRef.current[aId] = el;
    else delete arrowGsRef.current[aId];
  }, []);

  /* ================================================================
     Keyboard nudge API — exposed to App so its WASD handler can
     imperatively move a node + its connected arrows without going
     through React state on every tick. State is committed on release.
     ================================================================ */
  const kbNudgeStateRef = useRef(null); // { nodeId, baseX, baseY, dx, dy, affectedArrows }

  const kbNudgeNode = useCallback((nodeId, dx, dy) => {
    const allNodes  = nodesRef.current;
    const allArrows = arrowsRef.current;
    const heights   = nodeHeightRef.current;

    let st = kbNudgeStateRef.current;
    if (!st || st.nodeId !== nodeId) {
      const node = allNodes[nodeId];
      if (!node) return;
      // Build affected arrows in topological order: arrows directly
      // attached, then arrows whose endpoint is a pill of an already-
      // affected arrow, transitively.
      const affected = [];
      const seen = new Set();
      let frontier = [];
      for (const aId of Object.keys(allArrows)) {
        const a = allArrows[aId];
        if (a.fromNodeId === nodeId || a.toNodeId === nodeId) {
          frontier.push(aId); seen.add(aId); affected.push(aId);
        }
      }
      while (frontier.length) {
        const next = [];
        for (const aId of Object.keys(allArrows)) {
          if (seen.has(aId)) continue;
          const a = allArrows[aId];
          if ((a.fromPillArrowId && seen.has(a.fromPillArrowId)) ||
              (a.toPillArrowId   && seen.has(a.toPillArrowId))) {
            next.push(aId); seen.add(aId); affected.push(aId);
          }
        }
        frontier = next;
      }
      st = { nodeId, baseX: node.x, baseY: node.y, dx: 0, dy: 0, affectedArrows: affected };
      kbNudgeStateRef.current = st;
    }
    st.dx += dx;
    st.dy += dy;
    const newX = st.baseX + st.dx;
    const newY = st.baseY + st.dy;

    const el = nodeElsRef.current[nodeId];
    if (el) {
      el.style.left = newX + 'px';
      el.style.top  = newY + 'px';
    }

    if (st.affectedArrows.length === 0) return;
    const draggedSnap = { ...allNodes[nodeId], x: newX, y: newY };
    const ahSize = vpRef.current.zoom < 0.4 ? 18 : 12;
    const liveNodes = { ...allNodes, [nodeId]: draggedSnap };
    const resolvePos = (arrow, end) => resolveEndpoint(arrow, end, liveNodes, allArrows, heights, EDGE_KINDS, regionsRef.current);
    for (const aId of st.affectedArrows) {
      const a = allArrows[aId];
      if (!a) continue;
      const from = resolvePos(a, 'from');
      const to   = resolvePos(a, 'to');
      if (!from || !to) continue;
      const { path, cp1x, cp1y, cp2x, cp2y, midX, midY, midAngle } = bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, a.fromCtrl, a.toCtrl);
      const g = arrowGsRef.current[aId];
      if (!g) continue;
      const paths = g.querySelectorAll(':scope > path');
      const dPath = headedPath({ path }, arrowsModeOf(a, a.kind ? EDGE_KINDS[a.kind] : null), ahSize);
      for (const p of paths) p.setAttribute('d', dPath);
      const polygons = g.querySelectorAll('polygon.arrow-marker');
      if (polygons.length >= 1) polygons[0].setAttribute('points', arrowheadPoints(to.x, to.y, cp2x, cp2y, ahSize));
      if (polygons.length >= 2) polygons[1].setAttribute('points', arrowheadPoints(from.x, from.y, cp1x, cp1y, ahSize));
      const aKindDef2 = a.kind ? EDGE_KINDS[a.kind] : null;
      let mt2 = `translate(${midX} ${midY})`;
      if (aKindDef2 && aKindDef2.rotateWithFlow) mt2 += ` rotate(${snapAngle(midAngle)})`;
      const midGroups = g.querySelectorAll(':scope > g');
      for (const mg of midGroups) mg.setAttribute('transform', mg.classList.contains('arrow-not') ? `translate(${midX} ${midY})` : mt2);
      const fo = g.querySelector(':scope > foreignObject');
      if (fo) {
        fo.setAttribute('x', midX - 84);
        fo.setAttribute('y', midY - 30);
      }
    }
  }, []);

  const kbCommitNode = useCallback(() => {
    const st = kbNudgeStateRef.current;
    if (!st) return;
    if (st.dx !== 0 || st.dy !== 0) {
      // Snap final position to the grid so smooth-motion nudges still settle
      // onto whole grid units.
      const x = Math.round((st.baseX + st.dx) / GRID_SIZE) * GRID_SIZE;
      const y = Math.round((st.baseY + st.dy) / GRID_SIZE) * GRID_SIZE;
      onUpdateNode(st.nodeId, { x, y });
    }
    kbNudgeStateRef.current = null;
  }, [onUpdateNode]);

  /* ---- Imperative pan (keyboard scrolling of the canvas) ---- */
  const kbPan = useCallback((dx, dy) => {
    const vp = vpRef.current;
    writeVp({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy });
  }, [writeVp]);
  const kbPanCommit = useCallback(() => {
    onUpdateViewport({ ...vpRef.current });
  }, [onUpdateViewport]);

  // Pan so world point (wx, wy) lands in the middle of the board element.
  const kbCenterOn = useCallback((wx, wy) => {
    const vp = vpRef.current;
    const rect = rootRef.current?.getBoundingClientRect();
    const w = rect?.width || window.innerWidth;
    const h = rect?.height || window.innerHeight;
    kbPan(w / 2 - (wx * vp.zoom + vp.panX), h / 2 - (wy * vp.zoom + vp.panY));
    onUpdateViewport({ ...vpRef.current });
  }, [kbPan, onUpdateViewport]);

  /* ---- Imperative zoom (keyboard +/-) — multiplies current zoom by
     `factor`, anchored on the screen centre. */
  const kbZoom = useCallback((factor) => {
    const vp = vpRef.current;
    let newZoom = vp.zoom * factor;
    newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    if (newZoom === vp.zoom) return;
    const scale = newZoom / vp.zoom;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    writeVp({ zoom: newZoom, panX: cx - (cx - vp.panX) * scale, panY: cy - (cy - vp.panY) * scale });
  }, [writeVp]);
  const kbZoomCommit = useCallback(() => {
    onUpdateViewport({ ...vpRef.current });
  }, [onUpdateViewport]);

  // Expose the imperative API to App via the ref prop.
  useEffect(() => {
    if (!kbNudgeApiRef) return;
    kbNudgeApiRef.current = {
      nudge: kbNudgeNode, commit: kbCommitNode,
      pan: kbPan, panCommit: kbPanCommit, centerOn: kbCenterOn,
      zoom: kbZoom, zoomCommit: kbZoomCommit,
    };
    return () => {
      if (kbNudgeApiRef) kbNudgeApiRef.current = {};
    };
  }, [kbNudgeApiRef, kbNudgeNode, kbCommitNode, kbPan, kbPanCommit, kbCenterOn, kbZoom, kbZoomCommit]);

  const measureAllNodes = useCallback(() => {
    const newMap = {};
    let changed = false;
    const nodeIds = Object.keys(nodesRef.current);
    for (const id of nodeIds) {
      const el = nodeElsRef.current[id];
      if (el) {
        const natural = el.offsetHeight;
        const snapped = Math.max(60, Math.ceil(natural / GRID_SIZE) * GRID_SIZE);
        newMap[id] = snapped;
        if (nodeHeightRef.current[id] !== snapped) {
          changed = true;
        }
      } else {
        newMap[id] = nodeHeightRef.current[id] || 60;
      }
    }
    for (const id of Object.keys(nodeHeightRef.current)) {
      if (!nodesRef.current[id]) {
        changed = true;
      }
    }
    if (changed) {
      nodeHeightRef.current = newMap;
      setNodeHeightMap(newMap);
    }
  }, []);

  // Use ResizeObserver to detect node size changes and re-measure
  const resizeObserverRef = useRef(null);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      measureAllNodes();
    });
    resizeObserverRef.current = ro;

    // Observe all currently registered node elements
    for (const el of Object.values(nodeElsRef.current)) {
      ro.observe(el);
    }

    return () => ro.disconnect();
  }, [measureAllNodes]);

  // Re-observe when nodes change (new nodes added or removed)
  useEffect(() => {
    const ro = resizeObserverRef.current;
    if (!ro) return;
    // Re-observe all current elements
    ro.disconnect();
    for (const el of Object.values(nodeElsRef.current)) {
      ro.observe(el);
    }
    // Trigger measurement via a microtask (not synchronous in effect body)
    queueMicrotask(() => measureAllNodes());
  }, [nodes, measureAllNodes]);

  /* ================================================================
     Render helpers
     ================================================================ */
  // Cache rendered rich-text (Markdown + LaTeX) HTML — recompute only when a
  // node's text actually changes, not on every position update. Keyed by text
  // content via a ref so node drag (which mutates nodes) doesn't invalidate it.
  const latexCacheRef = useRef({ byText: new Map(), byId: {} });
  const latexCache = useMemo(() => {
    const { byText } = latexCacheRef.current;
    const nextById = {};
    for (const node of Object.values(nodes)) {
      const text = node.text;
      if (text == null || text === '') continue;
      let html = byText.get(text);
      if (html === undefined) {
        html = renderRichToHtml(text);
        byText.set(text, html);
      }
      nextById[node.id] = html;
    }
    latexCacheRef.current.byId = nextById;
    return nextById;
    // We intentionally only re-run this when node text set changes; depending
    // on `nodes` is fine because the inner work is O(N) hash lookups.
  }, [nodes]);

  const { panX, panY, zoom } = viewport;
  const gridSize = GRID_SIZE * zoom;

  /* ---- Render arrows (SVG) ---- */
  const arrowSize = zoom < 0.4 ? 16 : 10; // bigger arrowheads at overview zoom
  const arrowElements = [];
  for (const aId of Object.keys(arrows)) {
    const arrow = arrows[aId];
    const from = resolveEndpoint(arrow, 'from', nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
    const to   = resolveEndpoint(arrow, 'to',   nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
    if (!from || !to) continue;
    const kindDef = arrow.kind ? EDGE_KINDS[arrow.kind] : null;
    // Geometry: bezier curve (default) or an orthogonal "elbow" connector.
    const isElbow = arrow.line === 'elbow' || arrow.line === 'straight';
    const { path, cp1x, cp1y, cp2x, cp2y, midX, midY, midAngle } = isElbow
      ? elbowPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor)
      : bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, arrow.fromCtrl, arrow.toCtrl);
    // Kind dictates color when set; otherwise fall back to user color.
    const color = kindDef ? kindDef.stroke : (arrow.color || '#ffffff');
    const isSelected = selectedType === 'arrow' && selectedId === aId;
    const isInSelection = selection.arrowIds.has(aId);
    const isEditingLabel = editingArrowId === aId;
    const hasLabel = arrow.label && arrow.label.trim();
    // Arrowhead direction. Operators (render:'text') lock it semantically
    // (AND/OR/XOR → none, Consequently → forward, Equivalently → both); for
    // everything else the user picks via `arrow.direction`
    // (forward / reverse / both / none), with legacy `bidirectional` honored.
    const dirLocked = kindDef && kindDef.render === 'text';
    const arrowsMode = arrowsModeOf(arrow, kindDef);
    const shownPath = isElbow ? path : headedPath({ path }, arrowsMode, arrowSize);
    // Dash style: 0/undefined solid, 1 small dashes, 2 large dashes.
    const dashArr = arrow.dash === 1 ? '7 5' : arrow.dash === 2 ? '14 9' : null;
    // Operator pill — single symbol (∧ / ∨ / ⇒ / ⇔).
    const opText = kindDef && kindDef.render === 'text' ? kindDef.symbol : null;
    const pillW = PILL_TEXT_HALF_W * 2;
    const pillH = PILL_TEXT_HALF_H * 2;
    // Rotate directional glyphs (⇒ ⇔ ⊢ ⇀ ≡) along the bezier tangent at
    // the midpoint, so a vertical curve gets the symbol turned 90°.
    const midAngleDeg = (kindDef && kindDef.rotateWithFlow) ? snapAngle(midAngle) : 0;
    // ¬ strip geometry (operators only): local side facing screen-left.
    const notS = arrow.negated && kindDef && kindDef.render === 'text' ? notSideFor(midAngleDeg) : null;
    const notExt = { l: notS && notS.lx < 0 ? NOT_STRIP : 0, r: notS && notS.lx > 0 ? NOT_STRIP : 0, t: notS && notS.ly < 0 ? NOT_STRIP : 0, b: notS && notS.ly > 0 ? NOT_STRIP : 0 };
    const midTransform = midAngleDeg
      ? `translate(${midX} ${midY}) rotate(${midAngleDeg})`
      : `translate(${midX} ${midY})`;

    // Extra participants for n-ary operator arrows (∧ / ∨ / identical):
    // each is a `{ nodeId, anchor }` whose bezier converges on the same
    // pill, picking the pill side closest to the participant anchor.
    const participants = arrow.participants || [];
    const pillBounds = kindDef ? getPillBounds(arrow, EDGE_KINDS) : null;
    const participantPaths = [];
    if (participants.length && pillBounds) {
      for (const p of participants) {
        if (!p || !p.nodeId) continue;
        const pNode = nodes[p.nodeId];
        if (!pNode) continue;
        const pAnchorPos = getAnchorPos(pNode, p.anchor, nodeHeightMap);
        // Choose the closest pill cardinal side to keep crossings minimal.
        const sides = [
          { a: 'top',    x: midX,                  y: midY - pillBounds.halfH },
          { a: 'right',  x: midX + pillBounds.halfW, y: midY },
          { a: 'bottom', x: midX,                  y: midY + pillBounds.halfH },
          { a: 'left',   x: midX - pillBounds.halfW, y: midY },
        ];
        let best = sides[0], bestD = Infinity;
        for (const s of sides) {
          const d = (s.x - pAnchorPos.x) ** 2 + (s.y - pAnchorPos.y) ** 2;
          if (d < bestD) { bestD = d; best = s; }
        }
        const partial = bezierPath(pAnchorPos.x, pAnchorPos.y, p.anchor, best.x, best.y, best.a);
        participantPaths.push(partial.path);
      }
    }

    arrowElements.push(
      <g key={aId} ref={(el) => registerArrowG(aId, el)} style={{ color }}>
        {participantPaths.map((d, i) => (
          <path
            key={`p${i}`}
            d={d}
            className="arrow-path"
            stroke={color}
            fill="none"
            pointerEvents="none"
          />
        ))}
        <path
          d={shownPath}
          className="arrow-path-hit"
          fill="none"
          onClick={(e) => onArrowClick(e, aId)}
          onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
        />
        <path
          d={shownPath}
          className={`arrow-path${isSelected || isInSelection ? ' selected' : ''}`}
          stroke={color}
          strokeDasharray={dashArr || undefined}
          fill="none"
          onClick={(e) => onArrowClick(e, aId)}
          onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
        />
        {(arrowsMode === 'forward' || arrowsMode === 'both') && (
          <polygon
            points={arrowheadPoints(to.x, to.y, cp2x, cp2y, arrowSize)}
            className="arrow-marker"
            style={{ color }}
            fill={color}
          />
        )}
        {(arrowsMode === 'reverse' || arrowsMode === 'both') && (
          <polygon
            points={arrowheadPoints(from.x, from.y, cp1x, cp1y, arrowSize)}
            className="arrow-marker"
            style={{ color }}
            fill={color}
          />
        )}
        {kindDef && opText && (
          <g
            transform={midTransform}
            className={`arrow-pill${isSelected || isInSelection ? ' selected' : ''}`}
            onClick={(e) => onArrowClick(e, aId)}
            onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
          >
            {/* Body — one grid cell larger on the ¬ side when negated, so it is one outline. */}
            <rect
              x={-pillW / 2 - notExt.l} y={-pillH / 2 - notExt.t}
              width={pillW + notExt.l + notExt.r} height={pillH + notExt.t + notExt.b}
              rx={pillH / 2} ry={pillH / 2}
              fill="#0e0e10" stroke={color} strokeWidth={1.6}
            />
            {notS && (
              /* ¬( … ): the extra cell, outlined in red; the closing edge is the divider. */
              <path d={notStripPath(notS, pillW / 2, pillH / 2)} fill="none" stroke="#ff6b6b" strokeWidth={1.6} pointerEvents="none" />
            )}
            {kindDef.icon ? (
              <path d={kindDef.icon} transform="scale(0.85)" fill="none" stroke={color} strokeWidth={1.8}
                strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
            ) : arrow.kind === 'xor' ? (
              /* XOR — a circle quartered by a full-diameter cross. */
              <g pointerEvents="none">
                <circle r={8} fill="none" stroke={color} strokeWidth={1.8} />
                <line x1={-8} y1={0} x2={8} y2={0} stroke={color} strokeWidth={1.8} />
                <line x1={0} y1={-8} x2={0} y2={8} stroke={color} strokeWidth={1.8} />
              </g>
            ) : (
              <text
                x={0} y={2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                pointerEvents="none"
                style={{ font: '700 19px ui-sans-serif, system-ui, sans-serif' }}
              >
                {opText}
              </text>
            )}
            {/* Anchor dots — drag from these to create new arrows out of the pill. */}
            <circle className="pill-anchor top"    cx={0}         cy={-pillH / 2} r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'top')} />
            <circle className="pill-anchor right"  cx={pillW / 2} cy={0}          r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'right')} />
            <circle className="pill-anchor bottom" cx={0}         cy={pillH / 2}  r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'bottom')} />
            <circle className="pill-anchor left"   cx={-pillW / 2} cy={0}         r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'left')} />
          </g>
        )}
        {notS && (
          /* The "~" stays upright, astride the divider on the pill's screen-left. */
          <g className="arrow-not" transform={`translate(${midX} ${midY})`} pointerEvents="none">
            <text x={-(midAngleDeg % 180 === 0 ? pillW / 2 : pillH / 2) - NOT_STRIP / 2} y={1} textAnchor="middle" dominantBaseline="middle" fill="#ff6b6b"
              style={{ font: '400 18px ui-sans-serif, system-ui, sans-serif' }}>~</text>
          </g>
        )}
        {kindDef && kindDef.render === 'glyph' && (
          <g
            transform={midTransform}
            className={`arrow-pill${isSelected || isInSelection ? ' selected' : ''}`}
            onClick={(e) => onArrowClick(e, aId)}
            onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
          >
            {kindDef.weighted ? (
              <rect
                x={-pillBounds.halfW} y={-pillBounds.halfH}
                width={pillBounds.halfW * 2} height={pillBounds.halfH * 2}
                rx={pillBounds.halfH} ry={pillBounds.halfH}
                fill="#0e0e10" stroke={color} strokeWidth={1.6}
              />
            ) : (
              <circle r={PILL_GLYPH_HALF} fill="#0e0e10" stroke={color} strokeWidth={1.6} />
            )}
            {/* Glyph icon — shifted into the left half for weighted pills. */}
            <g transform={`${kindDef.weighted ? `translate(${-pillBounds.halfW + 13} 0) ` : ''}scale(0.87)`}>
            {kindDef.glyph === 'plus' && (
              <>
                <line x1={-7.5} y1={0} x2={7.5} y2={0} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
                <line x1={0} y1={-7.5} x2={0} y2={7.5} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
              </>
            )}
            {kindDef.glyph === 'cross' && (
              <>
                <line x1={-6} y1={-6} x2={6} y2={6} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
                <line x1={-6} y1={6} x2={6} y2={-6} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
              </>
            )}
            {kindDef.glyph === 'narrow' && (
              <>
                {/* Two converging chevrons, like ›‹ — refining / narrowing */}
                <polyline points="-7.5,-6 -1.5,0 -7.5,6" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="7.5,-6 1.5,0 7.5,6" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}
            {kindDef.glyph === 'dots' && (
              <>
                <circle cx={-6} cy={0} r={2} fill={color} />
                <circle cx={0}  cy={0} r={2} fill={color} />
                <circle cx={6}  cy={0} r={2} fill={color} />
              </>
            )}
            {kindDef.glyph === 'tri-up' && (
              /* Upward filled triangle — specific generalizes upward */
              <polygon points="-7.5,6 7.5,6 0,-7.5" fill={color} />
            )}
            {kindDef.glyph === 'circ-slash' && (
              /* Slashed circle (⊘) — counter-example / exception */
              <line x1={-7.5} y1={7.5} x2={7.5} y2={-7.5} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
            )}
            {kindDef.glyph === 'turnstile' && (
              /* Turnstile (⊢) — presupposes / rests on */
              <>
                <line x1={-4.5} y1={-7.5} x2={-4.5} y2={7.5} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
                <line x1={-4.5} y1={0}    x2={6}    y2={0}   stroke={color} strokeWidth={2.5} strokeLinecap="round" />
              </>
            )}
            {kindDef.glyph === 'tri-bar' && (
              /* Triple bar (≡) — equivalent */
              <>
                <line x1={-7.5} y1={-4.5} x2={7.5} y2={-4.5} stroke={color} strokeWidth={2.2} strokeLinecap="round" />
                <line x1={-7.5} y1={0}    x2={7.5} y2={0}    stroke={color} strokeWidth={2.2} strokeLinecap="round" />
                <line x1={-7.5} y1={4.5}  x2={7.5} y2={4.5}  stroke={color} strokeWidth={2.2} strokeLinecap="round" />
              </>
            )}
            {kindDef.glyph === 'half-arrow' && (
              /* ⇀ — "necessary condition for". Half-arrow visually
                 captures "necessary but not sufficient" — a leading
                 direction without a full implication head. */
              <text
                x={0} y={1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                style={{ font: '700 24px ui-sans-serif, system-ui, sans-serif' }}
              >
                ⇀
              </text>
            )}
            {kindDef.glyph === 'sufficient' && (
              /* "sufficient condition for" — a full arrow literally composed
                 of two "necessary condition" half-arrows: the upper harpoon
                 ⇀ and the lower harpoon ⇁ overlapped. A "?" sits on the left
                 (the conditional "if"). */
              <>
                <text
                  x={-8} y={1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={color}
                  style={{ font: '400 13px ui-sans-serif, system-ui, sans-serif' }}
                >
                  ?
                </text>
                {/* Both halves are the SAME glyph (⇀) — the lower one is the
                    upper one mirrored vertically, so the two halves match
                    exactly instead of using a mismatched ⇁ from the font. */}
                <text
                  x={3} y={0}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={color}
                  style={{ font: '700 18px ui-sans-serif, system-ui, sans-serif' }}
                >
                  ⇀
                </text>
                <text
                  x={3} y={0}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={color}
                  transform="scale(1 -1)"
                  style={{ font: '700 18px ui-sans-serif, system-ui, sans-serif' }}
                >
                  ⇀
                </text>
              </>
            )}
            {kindDef.glyph === 'approx' && (
              /* ≈ — "analogous to". Two wavy lines = similarity / analogy.
                 Centered in the pill. */
              <>
                <path d="M -5 -3 q 2.5 -3 5 0 q 2.5 3 5 0" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
                <path d="M -5 3 q 2.5 -3 5 0 q 2.5 3 5 0" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
              </>
            )}
            {kindDef.glyph === 'percent-down' && (
              /* % whose diagonal is an arrow pointing ↙ — "decreases probability". */
              <>
                <circle cx={-4.5} cy={-4.5} r={2.3} fill="none" stroke={color} strokeWidth={1.8} />
                <circle cx={4.5}  cy={4.5}  r={2.3} fill="none" stroke={color} strokeWidth={1.8} />
                <line x1={8.25} y1={-8.25} x2={-4.5} y2={4.5} stroke={color} strokeWidth={2.8} strokeLinecap="round" />
                <polygon points="-9,9 -3,7.13 -7.13,3" fill={color} />
              </>
            )}
            {kindDef.glyph === 'percent-up' && (
              /* % whose diagonal is an arrow pointing ↗ — "increases probability". */
              <>
                <circle cx={-4.5} cy={-4.5} r={2.3} fill="none" stroke={color} strokeWidth={1.8} />
                <circle cx={4.5}  cy={4.5}  r={2.3} fill="none" stroke={color} strokeWidth={1.8} />
                <line x1={-8.25} y1={8.25} x2={4.5} y2={-4.5} stroke={color} strokeWidth={2.8} strokeLinecap="round" />
                <polygon points="9,-9 3,-7.13 7.13,-3" fill={color} />
              </>
            )}
            </g>
            {/* Editable weight parameter (1–100) in the right half. */}
            {kindDef.weighted && (
              <>
                <line x1={pillBounds.halfW - 30} y1={-pillBounds.halfH + 5} x2={pillBounds.halfW - 30} y2={pillBounds.halfH - 5}
                  stroke={color} strokeWidth={1} opacity={0.45} />
                <foreignObject
                  x={pillBounds.halfW - 30} y={-pillBounds.halfH}
                  width={30} height={pillBounds.halfH * 2}
                  style={{ overflow: 'visible' }}
                >
                  <div
                    className="arrow-weight"
                    contentEditable
                    suppressContentEditableWarning
                    style={{ color }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const txt = (e.target.textContent || '').replace(/[^0-9]/g, '');
                      let n = parseInt(txt, 10);
                      if (!Number.isFinite(n)) n = 1;
                      n = Math.max(1, Math.min(100, n));
                      const cur = arrow.probWeight != null ? arrow.probWeight : 50;
                      if (n !== cur) onUpdateArrow(aId, { probWeight: n });
                      e.target.textContent = String(n);
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
                    ref={(el) => {
                      const v = String(arrow.probWeight != null ? arrow.probWeight : 50);
                      if (el && el.textContent !== v && document.activeElement !== el) el.textContent = v;
                    }}
                  />
                </foreignObject>
              </>
            )}
            {/* Anchor dots — drag from these to create new arrows out of the pill. */}
            <circle className="pill-anchor top"    cx={0}                  cy={-pillBounds.halfH} r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'top')} />
            <circle className="pill-anchor right"  cx={pillBounds.halfW}   cy={0}                 r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'right')} />
            <circle className="pill-anchor bottom" cx={0}                  cy={pillBounds.halfH}  r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'bottom')} />
            <circle className="pill-anchor left"   cx={-pillBounds.halfW}  cy={0}                 r={4.5} fill={color}
              onMouseDown={(e) => onPillAnchorMouseDown(e, aId, 'left')} />
          </g>
        )}
        {/* Arrow label */}
        {(hasLabel || isEditingLabel) && (
          <foreignObject
            x={midX - 84} y={midY - 30}
            width={168} height={60}
            style={{ overflow: 'visible' }}
          >
            <div
              className={`arrow-label${isEditingLabel ? ' editing' : ''}`}
              contentEditable={isEditingLabel}
              suppressContentEditableWarning
              onBlur={(e) => onArrowLabelBlur(e, aId)}
              onKeyDown={onArrowLabelKeyDown}
              onInput={() => {}}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => { e.stopPropagation(); onArrowDoubleClick(e, aId); }}
              ref={(el) => { if (el && isEditingLabel) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } }}
            >
              {arrow.label || ''}
            </div>
          </foreignObject>
        )}
      </g>
    );
  }

  /* ---- Bezier control handles for the selected arrow (Illustrator-style) ---- */
  if (showArrowHandles && selectedType === 'arrow' && selectedId && arrows[selectedId]) {
    const arrow = arrows[selectedId];
    const from = resolveEndpoint(arrow, 'from', nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
    const to   = resolveEndpoint(arrow, 'to',   nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
    if (from && to) {
      const { cp1x, cp1y, cp2x, cp2y } = bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, arrow.fromCtrl, arrow.toCtrl);
      // Keep handles a constant screen size regardless of zoom.
      const r = 7 / zoom;
      const sw = 1.5 / zoom;
      arrowElements.push(
        <g key="__handles__" className="arrow-handles" ref={arrowHandlesGRef}>
          <line x1={from.x} y1={from.y} x2={cp1x} y2={cp1y} className="arrow-handle-leash" strokeWidth={sw} />
          <line x1={to.x}   y1={to.y}   x2={cp2x} y2={cp2y} className="arrow-handle-leash" strokeWidth={sw} />
          <circle
            cx={cp1x} cy={cp1y} r={r}
            className="arrow-handle"
            onMouseDown={(e) => onArrowHandleMouseDown(e, selectedId, 'from')}
            onDoubleClick={(e) => onArrowHandleDoubleClick(e, selectedId, 'from')}
          />
          <circle
            cx={cp2x} cy={cp2y} r={r}
            className="arrow-handle"
            onMouseDown={(e) => onArrowHandleMouseDown(e, selectedId, 'to')}
            onDoubleClick={(e) => onArrowHandleDoubleClick(e, selectedId, 'to')}
          />
        </g>
      );
    }
  }

  /* ---- Preview arrow while dragging ---- */
  if (arrowPreview) {
    // Resolve start point: from node anchor or another arrow's pill.
    let from = null;
    let fromAnchorName = arrowPreview.fromAnchor;
    if (arrowPreview.fromPillArrowId) {
      const host = arrows[arrowPreview.fromPillArrowId];
      if (host) {
        const hf = resolveEndpoint(host, 'from', nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
        const ht = resolveEndpoint(host, "to",   nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
        if (hf && ht) {
          const { midX, midY } = bezierPath(hf.x, hf.y, hf.anchor, ht.x, ht.y, ht.anchor, host.fromCtrl, host.toCtrl);
          const b = getPillBounds(host, EDGE_KINDS);
          const an = arrowPreview.fromAnchor;
          if (b && an === 'top')         from = { x: midX,           y: midY - b.halfH };
          else if (b && an === 'bottom') from = { x: midX,           y: midY + b.halfH };
          else if (b && an === 'left')   from = { x: midX - b.halfW, y: midY };
          else if (b && an === 'right')  from = { x: midX + b.halfW, y: midY };
          else                           from = { x: midX,           y: midY };
        }
      }
    } else if (arrowPreview.fromRegionId) {
      const fromRegion = regions[arrowPreview.fromRegionId];
      if (fromRegion) {
        from = getRegionAnchorPos(fromRegion, arrowPreview.fromAnchor);
      }
    } else {
      const fromNode = nodes[arrowPreview.fromNodeId];
      if (fromNode) {
        from = getAnchorPos(fromNode, arrowPreview.fromAnchor, nodeHeightMap);
      }
    }
    if (from) {
      let ex, ey, toAnchor;
      if (arrowPreview.snapPillArrowId) {
        const host = arrows[arrowPreview.snapPillArrowId];
        if (host) {
          const hf = resolveEndpoint(host, 'from', nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
          const ht = resolveEndpoint(host, "to",   nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
          if (hf && ht) {
            const { midX, midY } = bezierPath(hf.x, hf.y, hf.anchor, ht.x, ht.y, ht.anchor, host.fromCtrl, host.toCtrl);
            const b = getPillBounds(host, EDGE_KINDS);
            const an = arrowPreview.snapPillAnchor;
            if (b && an === 'top')         { ex = midX;          ey = midY - b.halfH; }
            else if (b && an === 'bottom') { ex = midX;          ey = midY + b.halfH; }
            else if (b && an === 'left')   { ex = midX - b.halfW; ey = midY; }
            else if (b && an === 'right')  { ex = midX + b.halfW; ey = midY; }
            else                            { ex = midX;          ey = midY; }
            toAnchor = an;
          }
        }
      } else if (arrowPreview.snapNodeId && arrowPreview.snapAnchor) {
        const toNode = nodes[arrowPreview.snapNodeId];
        if (toNode) {
          const to = getAnchorPos(toNode, arrowPreview.snapAnchor, nodeHeightMap);
          ex = to.x;
          ey = to.y;
          toAnchor = arrowPreview.snapAnchor;
        }
      } else if (arrowPreview.snapRegionId && arrowPreview.snapAnchor) {
        const toRegion = regions[arrowPreview.snapRegionId];
        if (toRegion) {
          const to = getRegionAnchorPos(toRegion, arrowPreview.snapAnchor);
          ex = to.x;
          ey = to.y;
          toAnchor = arrowPreview.snapAnchor;
        }
      }
      if (ex === undefined) {
        ex = arrowPreview.cursorX;
        ey = arrowPreview.cursorY;
        const dx = ex - from.x;
        const dy = ey - from.y;
        if (Math.abs(dx) > Math.abs(dy)) {
          toAnchor = dx > 0 ? 'left' : 'right';
        } else {
          toAnchor = dy > 0 ? 'top' : 'bottom';
        }
      }
      const { path, cp2x, cp2y } = bezierPath(from.x, from.y, fromAnchorName, ex, ey, toAnchor);
      arrowElements.push(
        <g key="__preview__" style={{ color: '#ffffff' }}>
          <path d={path} className="arrow-path preview" stroke="#ffffff" fill="none" />
          <polygon
            points={arrowheadPoints(ex, ey, cp2x, cp2y, 8)}
            fill="#ffffff"
            opacity={0.6}
          />
        </g>
      );
    }
  }

  /* ---- Free-arrow draw preview (Arrow tool) ---- */
  if (freeArrow) {
    const horiz = Math.abs(freeArrow.toX - freeArrow.fromX) >= Math.abs(freeArrow.toY - freeArrow.fromY);
    const dx = freeArrow.toX - freeArrow.fromX, dy = freeArrow.toY - freeArrow.fromY;
    const fromAnchor = horiz ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
    let ex = freeArrow.toX, ey = freeArrow.toY, toAnchor = horiz ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'top' : 'bottom');
    const snapped = freeArrow.snapNodeId || freeArrow.snapRegionId;
    if (freeArrow.snapNodeId && freeArrow.snapAnchor && nodes[freeArrow.snapNodeId]) {
      const p = getAnchorPos(nodes[freeArrow.snapNodeId], freeArrow.snapAnchor, nodeHeightMap);
      ex = p.x; ey = p.y; toAnchor = freeArrow.snapAnchor;
    } else if (freeArrow.snapRegionId && freeArrow.snapAnchor && regions[freeArrow.snapRegionId]) {
      const p = getRegionAnchorPos(regions[freeArrow.snapRegionId], freeArrow.snapAnchor);
      ex = p.x; ey = p.y; toAnchor = freeArrow.snapAnchor;
    }
    const col = snapped ? '#52c98b' : '#ffffff';
    const { path, cp2x, cp2y } = bezierPath(freeArrow.fromX, freeArrow.fromY, fromAnchor, ex, ey, toAnchor);
    arrowElements.push(
      <g key="__free_preview__" style={{ color: col }}>
        <circle cx={freeArrow.fromX} cy={freeArrow.fromY} r={4} fill={col} opacity={0.6} />
        <path d={path} className="arrow-path preview" stroke={col} fill="none" />
        <polygon points={arrowheadPoints(ex, ey, cp2x, cp2y, 9)} fill={col} opacity={0.8} />
      </g>
    );
  }

  /* ---- Preview keyboard arrow-drag (I/J/K/L + WASD) ---- */
  if (kbArrowDrag) {
    // Resolve the source position — either a node anchor or a pill anchor
    // (when the user pressed I/J/K/L while an arrow was selected).
    let from = null;
    if (kbArrowDrag.sourceNodeId) {
      const fromNode = nodes[kbArrowDrag.sourceNodeId];
      if (fromNode) from = getAnchorPos(fromNode, kbArrowDrag.sourceAnchor, nodeHeightMap);
    } else if (kbArrowDrag.sourcePillArrowId) {
      const host = arrows[kbArrowDrag.sourcePillArrowId];
      if (host) {
        const hf = resolveEndpoint(host, 'from', nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
        const ht = resolveEndpoint(host, 'to',   nodes, arrows, nodeHeightMap, EDGE_KINDS, regions);
        if (hf && ht) {
          const { midX, midY } = bezierPath(hf.x, hf.y, hf.anchor, ht.x, ht.y, ht.anchor, host.fromCtrl, host.toCtrl);
          const b = getPillBounds(host, EDGE_KINDS);
          if (b) {
            let ax = midX, ay = midY;
            const an = kbArrowDrag.sourceAnchor;
            if (an === 'top')         ay -= b.halfH;
            else if (an === 'bottom') ay += b.halfH;
            else if (an === 'left')   ax -= b.halfW;
            else if (an === 'right')  ax += b.halfW;
            from = { x: ax, y: ay };
          }
        }
      }
    }
    if (from) {
      let ex, ey, toAnchor;
      if (kbArrowDrag.snapNodeId && kbArrowDrag.snapAnchor) {
        const toNode = nodes[kbArrowDrag.snapNodeId];
        if (toNode) {
          const to = getAnchorPos(toNode, kbArrowDrag.snapAnchor, nodeHeightMap);
          ex = to.x; ey = to.y; toAnchor = kbArrowDrag.snapAnchor;
        }
      }
      if (ex === undefined) {
        ex = kbArrowDrag.cursorX;
        ey = kbArrowDrag.cursorY;
        const dx = ex - from.x;
        const dy = ey - from.y;
        toAnchor = Math.abs(dx) > Math.abs(dy)
          ? (dx > 0 ? 'left' : 'right')
          : (dy > 0 ? 'top' : 'bottom');
      }
      const { path, cp2x, cp2y } = bezierPath(from.x, from.y, kbArrowDrag.sourceAnchor, ex, ey, toAnchor);
      const previewColor = kbArrowDrag.snapNodeId ? '#52c98b' : '#ffb54a';
      arrowElements.push(
        <g key="__kb_preview__" style={{ color: previewColor }}>
          <path d={path} className="arrow-path preview" stroke={previewColor} />
          <polygon
            points={arrowheadPoints(ex, ey, cp2x, cp2y, 9)}
            fill={previewColor}
            opacity={0.9}
          />
          {/* Small dot at the virtual cursor so the user sees where they are */}
          <circle cx={kbArrowDrag.cursorX} cy={kbArrowDrag.cursorY} r={5} fill={previewColor} opacity={0.6} />
        </g>
      );
    }
  }

  /* ---- Render nodes ---- */
  const nodeElements = Object.values(nodes).map((node) => {
    const isSelected = selectedType === 'node' && selectedId === node.id;
    const isEditing = editingNodeId === node.id;
    const isDragging = draggingNodeId === node.id;
    const isInSelection = selection.nodeIds.has(node.id);
    const kindDef = node.kind ? NODE_KINDS[node.kind] : null;
    // Kind takes precedence over the user-picked color when set.
    const color = kindDef ? kindDef.accent : (node.color || '#cf7bf0');
    const height = node.height || nodeHeightMap[node.id] || 60;

    // Figure nodes (rect / square / circle / triangle) render a transparent
    // container with an SVG shape behind the (optional) text.
    const isFigure = !!node.shape;

    const nodeStyle = {
      // A negated node is one grid cell wider to the left: the red ¬ strip.
      left: node.x - (node.negated && node.style !== 'text' ? NOT_STRIP : 0),
      top: node.y,
      width: (node.width || 220) + (node.negated && node.style !== 'text' ? NOT_STRIP : 0),
      paddingLeft: node.negated && node.style !== 'text' ? NOT_STRIP + 10 : undefined,
      minHeight: node.style === 'text' ? 20 : height,
      borderColor: (isSelected || isInSelection) ? color : ((node.style === 'text' || isFigure) ? 'transparent' : color),
      // Selection = a real highlight: a bright accent halo around the whole
      // node (works for text & figure nodes too, which have no box glow).
      boxShadow: (isSelected || isInSelection)
        ? `0 0 26px 7px ${color}66, inset 0 0 18px ${color}1c`
        : ((node.style === 'text' || isFigure) ? 'none' : `0 0 12px 2px ${color}22, inset 0 0 8px ${color}08`),
    };
    if (kindDef && node.style !== 'text' && !isFigure) {
      nodeStyle.background = kindDef.bg;
    }
    if (isFigure) nodeStyle.background = 'transparent';
    // Vertical text alignment (cross axis of the node's flex row).
    nodeStyle.alignItems = node.valign === 'bottom' ? 'flex-end'
      : node.valign === 'center' ? 'center' : 'flex-start';

    return (
      <div
        key={node.id}
        ref={(el) => registerNodeEl(node.id, el)}
        className={`wb-node${node.style === 'text' ? ' text-node' : ''}${isFigure ? ' figure-node' : ''}${isSelected ? ' selected' : ''}${isDragging ? ' dragging' : ''}${isInSelection ? ' in-selection' : ''}${kindDef ? ' kinded' : ''}`}
        style={nodeStyle}
        onMouseDown={(e) => onNodeMouseDown(e, node.id)}
      >
        {isFigure && (
          <svg className="node-figure" viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">
            {(node.shape === 'rect' || node.shape === 'square') && (
              <rect x="1.5" y="1.5" width="97" height="97" rx="10" fill={`${color}1f`} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            )}
            {(node.shape === 'circle' || node.shape === 'ellipse') && (
              <ellipse cx="50" cy="50" rx="48.5" ry="48.5" fill={`${color}1f`} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            )}
            {node.shape === 'triangle' && (
              <polygon points="50,2 98,98 2,98" fill={`${color}1f`} stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        )}
        {node.shape === 'image' && node.image && (
          <AssetImg className="node-image" src={node.image} assets={assets}
            // A picture placed without a known size (by the AI) takes its own proportions.
            onSize={node.fitImage ? (w, h) => { if (w && h) onUpdateNode(node.id, { height: Math.round(((node.width || 220) * h) / w), fitImage: false }); } : undefined} />
        )}
        {kindDef && (
          <div className="node-kind-label" style={{ color: kindDef.accent }}>
            {kindDef.label}
          </div>
        )}
        {noteFor && noteFor(node.id) && (
          <button
            className="node-note-open"
            title="Open note"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenNote && onOpenNote(noteFor(node.id)); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V10M9.5 2.5H13.5V6.5M13 3L7.5 8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {/* Status pill — epistemic state, shown below the node. */}
        {node.status && NODE_STATUSES[node.status] && (
          <div className="node-status" style={{ color: NODE_STATUSES[node.status].color, borderColor: NODE_STATUSES[node.status].color }}>
            {NODE_STATUSES[node.status].label}
          </div>
        )}
        {/* NOT modifier — top-right corner. Negation of this node's claim. */}
        {node.negated && (
          <div className="node-not-strip" title="Negated (NOT)">
            <span className="node-not-mark">~</span>
          </div>
        )}
        {/* Probability — editable percentage in top-right corner. Sits left of
            the NOT badge when both are enabled. */}
        {node.probability != null && (
          <div
            className="node-prob-pill"
            contentEditable
            suppressContentEditableWarning
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              // Strip non-digit/non-dot, parse as float, clamp [0, 100],
              // preserve up to 2 decimal places.
              const txt = (e.target.textContent || '').replace(/[^0-9.]/g, '');
              let n = parseFloat(txt);
              if (!Number.isFinite(n)) n = 0;
              n = Math.max(0, Math.min(100, n));
              n = Math.round(n * 100) / 100;
              if (n !== node.probability) onUpdateNode(node.id, { probability: n });
              e.target.textContent = n + '%';
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
            ref={(el) => {
              if (el && el.textContent !== node.probability + '%' && document.activeElement !== el) {
                el.textContent = node.probability + '%';
              }
            }}
          />
        )}
        {!isEditing && !sourceMode && latexCache[node.id] ? (
          <span
            className="node-text node-text-rendered"
            style={{ textAlign: node.align || 'left', color: node.style === 'text' ? (node.color || '#cf7bf0') : undefined,
              fontFamily: node.fontFamily ? FONT_FAMILIES[node.fontFamily] : undefined,
              fontSize: node.fontSize ? node.fontSize : undefined }}
            onClick={(e) => onTextClick(e, node.id)}
            dangerouslySetInnerHTML={{ __html: latexCache[node.id] }}
          />
        ) : (
          <span
            className="node-text"
            style={{ textAlign: node.align || 'left', color: node.style === 'text' ? (node.color || '#cf7bf0') : undefined,
              fontFamily: node.fontFamily ? FONT_FAMILIES[node.fontFamily] : undefined,
              fontSize: node.fontSize ? node.fontSize : undefined }}
            contentEditable={isMobile || isEditing}
            suppressContentEditableWarning
            readOnly={isMobile && !isEditing ? true : undefined}
            onClick={(e) => onTextClick(e, node.id)}
            onFocus={() => { if (isMobile) { onSelect(node.id, 'node'); setEditingNodeId(node.id); editingRef.current = node.id; } }}
            onBlur={(e) => onTextBlur(e, node.id)}
            onKeyDown={(e) => onTextKeyDown(e, node.id)}
            onInput={(e) => {
              updateEditPreview(node.id, e.target.innerText);
              const el = e.target.closest('.wb-node');
              if (el) {
                // fitWidth: widen to the longest unwrapped line (padding included),
                // between MIN_FIT_WIDTH and MAX_FIT_WIDTH; beyond that, wrap.
                let fitted = null;
                if (node.fitWidth) {
                  const span = e.target;
                  const prevWs = span.style.whiteSpace;
                  span.style.whiteSpace = 'pre';
                  const cs = getComputedStyle(el);
                  const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
                  // Measure the glyphs, not the span's box: the box is as wide as the
                  // node, so it would ratchet — grow on typing, never shrink on delete.
                  const range = document.createRange();
                  range.selectNodeContents(span);
                  const textW = range.getBoundingClientRect().width / (vpRef.current.zoom || 1);
                  fitted = Math.min(MAX_FIT_WIDTH, Math.max(MIN_FIT_WIDTH, Math.ceil((textW + extra) / GRID_SIZE) * GRID_SIZE));
                  span.style.whiteSpace = prevWs;
                  if (fitted !== (node.width || 220)) el.style.width = fitted + 'px';
                }
                el.style.minHeight = 'auto';
                const natural = el.offsetHeight;
                // Grow to fit content, but never shrink below the node's set
                // height — so figures and resized nodes don't collapse when
                // you start typing into them. snap() the floor so a stray
                // fractional height can't propagate through the grow path.
                const floor = Math.max(40, snap(node.height || 0));
                const snapped = Math.max(floor, Math.ceil(natural / GRID_SIZE) * GRID_SIZE);
                el.style.minHeight = snapped + 'px';
                // Grow symmetrically around the node's vertical centre so the
                // box expands up and down evenly, not only downward. The centre
                // is captured on the first keystroke of this edit and held
                // fixed; grid-snapping y makes it alternate bottom-down /
                // top-up per 20px step. Cleared on blur.
                let centerY = growthCenterRef.current[node.id];
                if (centerY == null) {
                  centerY = node.y + (snap(node.height || 0) || nodeHeightMap[node.id] || snapped) / 2;
                  growthCenterRef.current[node.id] = centerY;
                }
                const newY = snap(centerY - snapped / 2);
                const upd = { height: snapped };
                if (newY !== node.y) upd.y = newY;
                if (fitted != null && fitted !== node.width) upd.width = fitted;
                onUpdateNode(node.id, upd);
              }
            }}
          >
            {node.text}
          </span>
        )}

        {node.style !== 'text' && ANCHORS.map((a) => (
          <div
            key={a}
            className={`anchor-dot ${a}`}
            style={{ background: color }}
            onMouseDown={(e) => onAnchorMouseDown(e, node.id, a)}
          />
        ))}

        {/* Resize handles - shown when selected */}
        {(isSelected || isInSelection) && ['nw', 'ne', 'sw', 'se'].map((corner) => (
          <div
            key={corner}
            className={`resize-handle ${corner}`}
            onMouseDown={(e) => onResizeMouseDown(e, node.id, corner)}
          />
        ))}
      </div>
    );
  });

  const isOverview = viewport.zoom < 0.4;

  // Determine cursor class based on tool mode
  const cursorClass = toolMode === 'draw' ? ' draw-mode'
    : toolMode === 'eraser' ? ' eraser-mode'
    : toolMode === 'move' ? ' move-mode'
    : toolMode === 'arrow' ? ' arrow-mode'
    : toolMode === 'lasso' ? ' lasso-mode'
    : toolMode === 'space' ? ' space-mode'
    : (toolMode === 'node' || toolMode === 'region' || toolMode === 'figure') ? ' place-mode'
    : '';

  // Compute stroke selection bounding box for visual indicator
  // …for any group: strokes, or two or more nodes. Its corner handle scales
  // the whole selection.
  const strokeSelBounds = (selection.strokeIds.size > 0 || selection.nodeIds.size > 1)
    ? getSelectionBounds(selection, nodes, drawStrokes, nodeHeightMap)
    : null;
  // A single selected straight line: its two ends can be dragged (magnetic).
  const selLine = (selection.strokeIds.size === 1 && selection.nodeIds.size === 0)
    ? (drawStrokes || []).find((st) => selection.strokeIds.has(st.id) && st.shape === 'line' && st.points && st.points.length === 2)
    : null;
  const onLineEndMouseDown = (e, index) => {
    if (e.button !== 0 || !selLine) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { type: 'lineEnd', strokeId: selLine.id, index, points: selLine.points, moved: false };
  };
  const onSelResizeMouseDown = (e) => {
    if (e.button !== 0 || !strokeSelBounds) return;
    e.preventDefault();
    e.stopPropagation();
    const hm = nodeHeightRef.current;
    dragState.current = {
      type: 'selResize',
      bounds: strokeSelBounds,
      scale: 1,
      nodes: [...selection.nodeIds].map((id) => nodes[id]).filter(Boolean)
        .map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width || 220, height: n.height || hm[n.id] || 60 })),
      strokes: (drawStrokes || []).filter((st) => selection.strokeIds.has(st.id))
        .map((st) => ({ id: st.id, points: st.points, width: st.width || 2 })),
    };
  };

  const onSelRotateMouseDown = (e) => {
    if (e.button !== 0 || !strokeSelBounds) return;
    e.preventDefault();
    e.stopPropagation();
    const hm = nodeHeightRef.current;
    const b = strokeSelBounds;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const rect = rootRef.current.getBoundingClientRect();
    const vp = vpRef.current;
    const wx = ((activePenPos ? activePenPos.x : e.clientX) - rect.left - vp.panX) / vp.zoom;
    const wy = ((activePenPos ? activePenPos.y : e.clientY) - rect.top - vp.panY) / vp.zoom;
    dragState.current = {
      type: 'selRotate', cx, cy, a0: Math.atan2(wy - cy, wx - cx), angle: 0,
      nodes: [...selection.nodeIds].map((id) => nodes[id]).filter(Boolean)
        .map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width || 220, height: n.height || hm[n.id] || 60 })),
      strokes: (drawStrokes || []).filter((st) => selection.strokeIds.has(st.id)).map((st) => ({ id: st.id, points: st.points })),
    };
  };

  return (
    <div
      ref={rootRef}
      className={`canvas-root${isOverview ? ' overview' : ''}${cursorClass}${docLayout ? ' doc-mode' : ''}`}
      onMouseDown={onCanvasMouseDown}
      onDoubleClick={toolMode === 'select' ? onCanvasDoubleClick : undefined}
      onMouseLeave={onCanvasMouseLeave}
    >
      <div
        className="canvas-grid"
        style={{
          backgroundImage: `radial-gradient(circle at 0 0, rgba(207, 123, 240, 0.32) 1px, transparent 1px)`,
          backgroundSize: `${gridSize}px ${gridSize}px`,
          backgroundPosition: `${panX % gridSize}px ${panY % gridSize}px`,
        }}
      />

      <div
        ref={transformRef}
        className="canvas-transform"
        style={{
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
        }}
      >
        {/* Sheets of a paged document (behind everything, never a click target) */}
        {docLayout && (
          <div className="page-layer">
            {docLayout.pages.map((pg, i) => (
              <div key={i} className={`doc-page bg-${pg.bg ? 'pdf' : docLayout.bg}`}
                style={{ left: pg.x, top: pg.y, width: pg.w, height: pg.h }}>
                {pg.bg && <PageBg bg={pg.bg} pdf={pdf} cssWidth={pg.w} zoom={zoom} wantText={textSnap} />}
                <span className="doc-page-num">{i + 1}</span>
              </div>
            ))}
          </div>
        )}

        {/* Regions layer */}
        <div className="region-layer">
          {Object.values(regions).map((region) => {
            const isRegionSelected = (selectedType === 'region' && selectedId === region.id) || (selection.regionIds && selection.regionIds.has(region.id));
            const color = region.color || '#cf7bf0';
            return (
              // The interior is inert (pointer-events none in CSS): you work inside
              // freely; the region moves by its border (.region-border-hit).
              <div key={region.id} className={`wb-region${isRegionSelected ? ' selected' : ''}${region.fill ? ' filled' : ''}`}
                style={{ left: region.x, top: region.y, width: region.w, height: region.h, '--region-color': color }}>
                <span className="region-label" contentEditable suppressContentEditableWarning style={{ color }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={(e) => onUpdateRegionRef.current(region.id, { label: e.target.textContent || '' })}>
                  {region.label || ''}
                </span>
                <div className="region-border-hit" onMouseDown={(e) => onRegionBorderMouseDown(e, region.id)} />
                {ANCHORS.map((a) => (
                  <div
                    key={a}
                    className={`region-anchor-dot ${a}`}
                    style={{ background: color }}
                    onMouseDown={(e) => onRegionAnchorMouseDown(e, region.id, a)}
                  />
                ))}
                {isRegionSelected && ['nw', 'ne', 'sw', 'se'].map((corner) => (
                  <div key={corner} className={`resize-handle ${corner}`} style={{ background: color }}
                    onMouseDown={(e) => onRegionResizeMouseDown(e, region.id, corner)} />
                ))}
              </div>
            );
          })}
        </div>

        <svg className="arrow-layer" width="20000" height="20000" viewBox="0 0 20000 20000">
          {arrowElements}
        </svg>

        <div className="node-layer">
          {nodeElements}
          {editPreview && nodes[editPreview.nodeId] && (() => {
            const n = nodes[editPreview.nodeId];
            const h = n.height || nodeHeightMap[n.id] || 60;
            return (
              <div className="edit-preview" style={{ left: n.x, top: n.y + h + 10, minWidth: Math.max(120, n.width || 220) }}
                dangerouslySetInnerHTML={{ __html: editPreview.html }} />
            );
          })()}
        </div>

        {/* Placement preview (Node / Region / Figure tools) */}
        {placePreview && (placePreview.w > 1 || placePreview.h > 1) && (
          <div
            className="place-preview"
            style={{
              left: placePreview.x, top: placePreview.y,
              width: placePreview.w, height: placePreview.h,
              borderRadius: (placePreview.kind === 'figure' && (figureShape === 'circle' || figureShape === 'ellipse')) ? '50%'
                : placePreview.kind === 'region' ? 8 : 20,
            }}
          />
        )}

        {/* Freehand drawing layer */}
        <svg className={`drawing-layer${toolMode === 'draw' ? ' active' : ''}`} width="1" height="1">
          {/* Persisted strokes — gel-pen fill outlines (memoised per stroke) */}
          {uniqueStrokes.map((stroke) => (
            <InkStroke
              key={stroke.id}
              stroke={stroke}
              selectable={toolMode === 'select'}
              selected={selection.strokeIds.has(stroke.id)}
              onDown={onStrokeMouseDown}
            />
          ))}
          {/* Live preview while drawing — painted imperatively (setDrawingPreview) */}
          <path ref={previewPathRef} className="freehand-stroke gel" stroke="none" style={{ display: 'none', pointerEvents: 'none' }} />
        </svg>

        {/* Eraser hit layer - catches mouse events in eraser mode */}
        {toolMode === 'eraser' && (
          <div className="eraser-hit-layer" />
        )}

        {/* Lasso: a hit layer above everything, so the loop can start anywhere */}
        {(toolMode === 'lasso' || toolMode === 'space') && (
          <div className="select-hit-layer lasso-top" />
        )}
        <div ref={spaceBandRef} className="space-band" style={{ display: 'none' }} />
        <svg className="select-rect-layer" width="1" height="1">
          <path ref={lassoPathRef} className="lasso-path" style={{ display: 'none' }} />
        </svg>

        {/* Select hit layer - catches mouse events in select mode for rect selection */}
        {toolMode === 'select' && (
          <div className="select-hit-layer" />
        )}

        {/* Rectangle selection visual */}
        {selectRect && (
          <svg className="select-rect-layer" width="1" height="1">
            <rect
              x={selectRect.x}
              y={selectRect.y}
              width={selectRect.w}
              height={selectRect.h}
              className="selection-rect"
              strokeWidth={1 / zoom}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
            />
          </svg>
        )}

        {/* Text being highlighted on a PDF page */}
        {textSel && (
          <svg className="select-rect-layer" width="1" height="1">
            {textSel.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.h / 2} fill={drawColor || '#ffd43b'} opacity={0.4} />)}
          </svg>
        )}

        {/* Stroke selection bounding box */}
        {strokeSelBounds && !selLine && (
          <svg className="select-rect-layer" width="1" height="1">
            <rect
              x={strokeSelBounds.x - 4 / zoom}
              y={strokeSelBounds.y - 4 / zoom}
              width={strokeSelBounds.w + 8 / zoom}
              height={strokeSelBounds.h + 8 / zoom}
              className="stroke-selection-rect"
              fill="none"
              stroke="#cf7bf0"
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${5 / zoom} ${3 / zoom}`}
              opacity={0.6}
            />
          </svg>
        )}
        {selLine && toolMode === 'select' && selLine.points.map((pt, i) => (
          <div
            key={i}
            className="sel-resize-handle line-end"
            title="Drag to move this end"
            style={{
              left: pt.x, top: pt.y,
              width: 14 / zoom, height: 14 / zoom,
              marginLeft: -7 / zoom, marginTop: -7 / zoom,
              borderWidth: 2 / zoom,
            }}
            onMouseDown={(e) => onLineEndMouseDown(e, i)}
          />
        ))}
        {strokeSelBounds && !selLine && toolMode === 'select' && (
          <div
            className="sel-resize-handle"
            title="Drag to resize the selection"
            style={{
              left: strokeSelBounds.x + strokeSelBounds.w + 4 / zoom,
              top: strokeSelBounds.y + strokeSelBounds.h + 4 / zoom,
              width: 14 / zoom, height: 14 / zoom,
              marginLeft: -7 / zoom, marginTop: -7 / zoom,
              borderWidth: 2 / zoom,
            }}
            onMouseDown={onSelResizeMouseDown}
          />
        )}
        {strokeSelBounds && !selLine && toolMode === 'select' && (
          <div
            className="sel-resize-handle rotate"
            title="Drag to rotate the selection (Shift: 15° steps)"
            style={{
              left: strokeSelBounds.x + strokeSelBounds.w / 2,
              top: strokeSelBounds.y - 24 / zoom,
              width: 14 / zoom, height: 14 / zoom,
              marginLeft: -7 / zoom, marginTop: -7 / zoom,
              borderWidth: 2 / zoom,
            }}
            onMouseDown={onSelRotateMouseDown}
          />
        )}

        {/* Eraser cursor circle - radius converted to world units */}
        {toolMode === 'eraser' && eraserCursor && (
          <svg className="eraser-cursor-layer" width="1" height="1">
            <circle
              cx={eraserCursor.x}
              cy={eraserCursor.y}
              r={eraserRadius / zoom}
              className="eraser-cursor"
              strokeWidth={1.5 / zoom}
            />
          </svg>
        )}

      </div>
    </div>
  );
}
