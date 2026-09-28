import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { getStroke } from 'perfect-freehand';
import './canvas.css';
import 'katex/dist/katex.min.css';
import { renderRichToHtml } from './richtext.js';
import { NODE_KINDS, EDGE_KINDS, NODE_STATUSES, FONT_FAMILIES } from './argTypes.js';

export const GRID_SIZE = 20;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.0;
const ZOOM_IN_FACTOR = 1.08;
const ZOOM_OUT_FACTOR = 0.92;

export const ANCHORS = ['top', 'right', 'bottom', 'left'];

/* ================================================================
   Utility: get anchor world position for a node
   ================================================================ */
export function getAnchorPos(node, anchor, heightMap) {
  const w = node.width || 220;
  const h = node.height || (heightMap && heightMap[node.id]) || 60;
  switch (anchor) {
    case 'top':    return { x: node.x + w / 2, y: node.y };
    case 'right':  return { x: node.x + w,     y: node.y + h / 2 };
    case 'bottom': return { x: node.x + w / 2, y: node.y + h };
    case 'left':   return { x: node.x,         y: node.y + h / 2 };
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

  return { path: `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${ex} ${ey}`, cp1x, cp1y, cp2x, cp2y, midX, midY };
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
  // cp1/cp2 = neighbours of the endpoints → correct arrowhead orientation.
  return {
    path: roundedPolyPath(pts, 16),
    cp1x: pts[1][0], cp1y: pts[1][1],
    cp2x: pts[pts.length - 2][0], cp2y: pts[pts.length - 2][1],
    midX, midY,
  };
}

/* ================================================================
   Utility: arrowhead points at end of curve
   ================================================================ */
export function arrowheadPoints(ex, ey, cp2x, cp2y, size = 10) {
  const dx = ex - cp2x;
  const dy = ey - cp2y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const x1 = ex - ux * size + px * size * 0.4;
  const y1 = ey - uy * size + py * size * 0.4;
  const x2 = ex - ux * size - px * size * 0.4;
  const y2 = ey - uy * size - py * size * 0.4;
  return `${ex},${ey} ${x1},${y1} ${x2},${y2}`;
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

/* ================================================================
   Utility: pill bounds (half-width, half-height) for a typed arrow.

   Used to project arrow endpoints to the pill BORDER (not center)
   based on which anchor (top/right/bottom/left) is attached.
   ================================================================ */
const PILL_TEXT_HALF_W = 20; // pillW=40
const PILL_TEXT_HALF_H = 15; // pillH=30
const PILL_GLYPH_HALF  = 15; // circle r=15
const PILL_WEIGHTED_HALF_W = 30; // widened pill: glyph + editable number
const PILL_WEIGHTED_HALF_H = 15;

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
    const { midX, midY, cp1x, cp1y, cp2x, cp2y } = bezierPath(hf.x, hf.y, hf.anchor, ht.x, ht.y, ht.anchor, host.fromCtrl, host.toCtrl);
    const b = getPillBounds(host, edgeKinds);
    if (!b || centerOnly) return { x: midX, y: midY, anchor: null };
    // The pill is drawn rotated along its curve for rotateWithFlow kinds.
    const hk = host.kind ? edgeKinds[host.kind] : null;
    const ang = hk && hk.rotateWithFlow ? Math.atan2(cp2y - cp1y, cp2x - cp1x) : 0;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    // Enter/leave through the side that faces the arrow's other end — never
    // the centre. (A pill-to-pill arrow aims at the other pill's centre.)
    const other = resolveEndpoint(arrow, end === 'from' ? 'to' : 'from', nodes, arrows, heights, edgeKinds, regions, depth + 1, true);
    let lx, ly; // chosen side in the pill's local frame (unit direction)
    if (other) {
      const dx = other.x - midX, dy = other.y - midY;
      const ox = dx * cos + dy * sin, oy = -dx * sin + dy * cos;
      if (Math.abs(ox) * b.halfH >= Math.abs(oy) * b.halfW) { lx = ox >= 0 ? 1 : -1; ly = 0; }
      else { lx = 0; ly = oy >= 0 ? 1 : -1; }
    } else {
      const n = anchorNormal(anchor) || { nx: 1, ny: 0 };
      lx = n.nx; ly = n.ny;
    }
    const px = lx * b.halfW, py = ly * b.halfH;
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
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
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
// Pen: holding the pointer down longer than this collapses the stroke to a
// straight line from the press point to the cursor (press-and-hold = ruler).
const HOLD_STRAIGHTEN_MS = 1800;
function appendStrokePoint(cs, x, y) {
  if (!cs) return;
  if (!cs.straight && cs.t0 != null && Date.now() - cs.t0 > HOLD_STRAIGHTEN_MS) cs.straight = true;
  if (cs.straight) cs.points = [cs.points[0], { x, y }];
  else cs.points.push({ x, y });
}

export function gelStrokePath(points, width) {
  if (!points || points.length === 0) return '';
  const outline = getStroke(points.map((p) => [p.x, p.y]), {
    // `size` is the brush diameter in px — keep it ~1:1 with the stored
    // width so strokes match the old line weight (no 3× fattening).
    size: Math.max(1.5, width || 4),
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
    last: true,
  });
  if (!outline.length) return '';
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
function pixelEraseStrokes(strokes, cx, cy, radius) {
  let changed = false;
  const result = [];

  for (const stroke of strokes) {
    if (!stroke.points || stroke.points.length === 0) {
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
    const h = (heightMap && heightMap[id]) || 60;
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
  onPlaceObject,
  figureShape,
  drawStrokes,
  onAddStroke,
  eraserMode,
  eraserRadius,
  onEraseObjects,
  onPixelErase,
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
  const [drawingPreview, setDrawingPreview] = useState(null); // SVG path string while drawing

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
    const newPanX = cx - (cx - vp.panX) * scale;
    const newPanY = cy - (cy - vp.panY) * scale;
    // Update vpRef + DOM directly (no React re-render per zoom frame)
    vpRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
    if (transformRef.current) {
      transformRef.current.style.transform = `translate(${newPanX}px, ${newPanY}px) scale(${newZoom})`;
    }
    const gridEl = rootRef.current?.querySelector('.canvas-grid');
    if (gridEl) {
      const gs = GRID_SIZE * newZoom;
      gridEl.style.backgroundSize = `${gs}px ${gs}px`;
      gridEl.style.backgroundPosition = `${newPanX % gs}px ${newPanY % gs}px`;
    }
    // Debounce React state sync
    clearTimeout(zoomSyncTimer.current);
    zoomSyncTimer.current = setTimeout(() => {
      onUpdateViewport({ ...vpRef.current });
    }, 150);
  }, [onUpdateViewport]);

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
        const newPanX = vp.panX - e.deltaX;
        const newPanY = vp.panY - e.deltaY;
        vpRef.current = { ...vp, panX: newPanX, panY: newPanY };
        if (transformRef.current) {
          transformRef.current.style.transform = `translate(${newPanX}px, ${newPanY}px) scale(${vp.zoom})`;
        }
        const gridEl = el.querySelector('.canvas-grid');
        if (gridEl) {
          const gs = GRID_SIZE * vp.zoom;
          gridEl.style.backgroundPosition = `${newPanX % gs}px ${newPanY % gs}px`;
        }
        // Sync React state after scrolling stops (150ms debounce)
        clearTimeout(wheelSyncTimer);
        wheelSyncTimer = setTimeout(() => {
          onUpdateViewport({ ...vpRef.current });
        }, 150);
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, onUpdateViewport]);

  /* ================================================================
     Touch handling — DESKTOP (existing, unchanged)
     ================================================================ */
  useEffect(() => {
    if (isMobile) return; // mobile has its own handler below
    const el = rootRef.current;
    if (!el) return;

    let lastTouches = null;

    function onTouchStart(e) {
      if (e.touches.length === 1) {
        lastTouches = [{ x: e.touches[0].clientX, y: e.touches[0].clientY }];
      } else if (e.touches.length === 2) {
        e.preventDefault();
        lastTouches = [
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        ];
      }
    }

    function onTouchMove(e) {
      if (!lastTouches) return;
      if (e.touches.length === 1 && lastTouches.length === 1) {
        if (dragState.current) return;
        const dx = e.touches[0].clientX - lastTouches[0].x;
        const dy = e.touches[0].clientY - lastTouches[0].y;
        const vp = vpRef.current;
        onUpdateViewport({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy });
        lastTouches = [{ x: e.touches[0].clientX, y: e.touches[0].clientY }];
      } else if (e.touches.length === 2 && lastTouches.length === 2) {
        e.preventDefault();
        const prev = lastTouches;
        const cur = [
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        ];
        const prevDist = Math.sqrt((prev[1].x - prev[0].x) ** 2 + (prev[1].y - prev[0].y) ** 2);
        const curDist = Math.sqrt((cur[1].x - cur[0].x) ** 2 + (cur[1].y - cur[0].y) ** 2);
        const rect = el.getBoundingClientRect();
        const cx = (cur[0].x + cur[1].x) / 2 - rect.left;
        const cy = (cur[0].y + cur[1].y) / 2 - rect.top;
        const factor = curDist / (prevDist || 1);
        applyZoom(factor, cx, cy);

        const prevCx = (prev[0].x + prev[1].x) / 2 - rect.left;
        const prevCy = (prev[0].y + prev[1].y) / 2 - rect.top;
        const vp = vpRef.current;
        onUpdateViewport({ ...vp, panX: vp.panX + (cx - prevCx), panY: vp.panY + (cy - prevCy) });

        lastTouches = cur;
      }
    }

    function onTouchEnd() {
      lastTouches = null;
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [isMobile, applyZoom, onUpdateViewport]);

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
          currentStroke.current = { points: [{ x: world.x, y: world.y }], color: drawColorRef.current || '#cf7bf0', width: drawWidthRef.current || 2, opacity: drawOpacityRef.current, t0: Date.now(), straight: false };
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
            appendStrokePoint(currentStroke.current, wx, wy);
            setDrawingPreview(gelStrokePath(currentStroke.current.points, currentStroke.current.width));
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
          if (currentStroke.current && currentStroke.current.points.length > 1 && onAddStroke) {
            onAddStroke({ ...currentStroke.current });
          }
          currentStroke.current = null;
          setDrawingPreview(null);
        }
        if (touchStateRef.current.type === 'erase') {
          setEraserCursor(null);
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
                  const NEW_W = 220;
                  const NEW_H = 60;
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
  const eraserRadiusRef = useRef(eraserRadius);
  useEffect(() => { eraserRadiusRef.current = eraserRadius; }, [eraserRadius]);
  const drawStrokesRef = useRef(drawStrokes);
  useEffect(() => { drawStrokesRef.current = drawStrokes; }, [drawStrokes]);

  /* ---- Eraser perform ref (set below, used in event handlers) ---- */
  const performEraseRef = useRef(null);
  const onUpdateRegionRef = useRef(onUpdateRegion);
  useEffect(() => { onUpdateRegionRef.current = onUpdateRegion; }, [onUpdateRegion]);
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
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);

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

    if (toolMode === 'draw') {
      // Start freehand drawing
      e.preventDefault();
      currentStroke.current = { points: [{ x: world.x, y: world.y }], color: drawColor || '#cf7bf0', width: drawWidth || 2, opacity: drawOpacity == null ? 100 : drawOpacity, t0: Date.now(), straight: false };
      dragState.current = { type: 'draw' };
      setDrawingPreview(gelStrokePath([{ x: world.x, y: world.y }], (currentStroke.current && currentStroke.current.width) || drawWidthRef.current || 2));
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
  }, [onSelect, toolMode, drawColor, drawWidth, drawOpacity, screenToWorld, onSelectionChange, selection]);

  /* ================================================================
     Eraser perform helper
     ================================================================ */
  const performErase = useCallback((wx, wy) => {
    // Convert screen-pixel radius to world units
    const radius = eraserRadiusRef.current / vpRef.current.zoom;
    const mode = eraserModeRef.current;

    if (mode === 'object') {
      const currentNodes = nodesRef.current;
      const currentArrows = arrowsRef.current;
      const currentStrokes = drawStrokesRef.current || [];
      const hm = nodeHeightRef.current;

      const hitNodeIds = [];
      const hitArrowIds = [];
      const hitStrokeIds = [];

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
      for (const stroke of currentStrokes) {
        if (strokeHitsCircle(stroke, wx, wy, radius)) {
          hitStrokeIds.push(stroke.id);
        }
      }

      if (hitNodeIds.length || hitArrowIds.length || hitStrokeIds.length) {
        onEraseObjects({ nodeIds: hitNodeIds, arrowIds: hitArrowIds, strokeIds: hitStrokeIds });
      }
    } else {
      // Pixel erase
      const currentStrokes = drawStrokesRef.current || [];
      const { strokes: newStrokes, changed } = pixelEraseStrokes(currentStrokes, wx, wy, radius);
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
  }, [nodes, arrows, onSelect, screenToWorld, toolMode, selection, onSelectionChange, onToggleSelect]);

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
    // Locked region: select only — no move/resize (you can still pull
    // connections from its anchors, which have their own handlers).
    if (region.locked) return;
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
          appendStrokePoint(currentStroke.current, worldX, worldY);
          setDrawingPreview(gelStrokePath(currentStroke.current.points, currentStroke.current.width));
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

      if (ds.type === 'selectionDrag') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const dx = snap(worldX - ds.lastWorldX);
        const dy = snap(worldY - ds.lastWorldY);
        if (dx !== 0 || dy !== 0) {
          onMoveSelection(dx, dy);
          ds.lastWorldX += dx;
          ds.lastWorldY += dy;
        }
        return;
      }

      if (ds.type === 'pan') {
        // Update transform directly via DOM — no React re-render during pan.
        // This is critical for boards with many KaTeX nodes where React diffing
        // 30+ complex DOM trees per frame causes severe lag.
        const newPanX = ds.startPanX + (mx - ds.startX);
        const newPanY = ds.startPanY + (my - ds.startY);
        vpRef.current = { ...vpRef.current, panX: newPanX, panY: newPanY };
        if (transformRef.current) {
          transformRef.current.style.transform = `translate(${newPanX}px, ${newPanY}px) scale(${vpRef.current.zoom})`;
        }
        // Update grid background position directly
        const gridEl = rootRef.current?.querySelector('.canvas-grid');
        if (gridEl) {
          const gs = GRID_SIZE * vpRef.current.zoom;
          gridEl.style.backgroundPosition = `${newPanX % gs}px ${newPanY % gs}px`;
        }
      } else if (ds.type === 'node') {
        const vp = vpRef.current;
        const worldX = (mx - vp.panX) / vp.zoom;
        const worldY = (my - vp.panY) / vp.zoom;
        const newX = snap(worldX - ds.offsetX);
        const newY = snap(worldY - ds.offsetY);
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
          const ahSize = vp.zoom < 0.4 ? 16 : 10;
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
            const { path, cp1x, cp1y, cp2x, cp2y, midX, midY } = bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, a.fromCtrl, a.toCtrl);
            const g = arrowGsRef.current[aId];
            if (!g) continue;
            // Both <path> children (hit + visible) get the same `d`
            const paths = g.querySelectorAll(':scope > path');
            for (const p of paths) p.setAttribute('d', path);
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
            if (aKindDef && aKindDef.rotateWithFlow) {
              const ang = Math.atan2(cp2y - cp1y, cp2x - cp1x) * 180 / Math.PI;
              mt += ` rotate(${ang})`;
            }
            const midGroups = g.querySelectorAll(':scope > g');
            for (const mg of midGroups) mg.setAttribute('transform', mt);
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
            const { path, cp1x, cp1y, cp2x, cp2y, midX, midY } =
              bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, fromCtrl, toCtrl);
            const ahSize = vp.zoom < 0.4 ? 16 : 10;
            // Redraw the arrow's own <g> (paths, arrowheads, midpoint marker).
            const g = arrowGsRef.current[ds.arrowId];
            if (g) {
              const paths = g.querySelectorAll(':scope > path');
              for (const p of paths) p.setAttribute('d', path);
              const polygons = g.querySelectorAll('polygon.arrow-marker');
              if (polygons.length >= 1) polygons[0].setAttribute('points', arrowheadPoints(to.x, to.y, cp2x, cp2y, ahSize));
              if (polygons.length >= 2) polygons[1].setAttribute('points', arrowheadPoints(from.x, from.y, cp1x, cp1y, ahSize));
              const aKindDef = a.kind ? EDGE_KINDS[a.kind] : null;
              let mt = `translate(${midX} ${midY})`;
              if (aKindDef && aKindDef.rotateWithFlow) {
                const ang = Math.atan2(cp2y - cp1y, cp2x - cp1x) * 180 / Math.PI;
                mt += ` rotate(${ang})`;
              }
              const midGroups = g.querySelectorAll(':scope > g');
              for (const mg of midGroups) mg.setAttribute('transform', mt);
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
              points: cs.points.map(p => ({ x: p.x + sdx, y: p.y + sdy })),
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
            node:   { w: 220, h: 80 },
            region: { w: 300, h: 200 },
            figure: (figureShapeRef.current === 'rect' || figureShapeRef.current === 'ellipse') ? { w: 200, h: 120 } : { w: 140, h: 140 },
          };
          let { x, y, w, h } = p;
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
        if (currentStroke.current && currentStroke.current.points.length > 1 && onAddStroke) {
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
          onUpdateNode(ds.nodeId, { x: ds.lastX, y: ds.lastY });
        }
        setDraggingNodeId(null);
        onNodeDragEnd();
      }
      if (ds && ds.type === 'erase') {
        // Erase done
      }
      if (ds && ds.type === 'rectSelect') {
        setSelectRect(null);
        // If user didn't move, it was a click on empty space -> already cleared selection
        if (!ds.moved) {
          // Start panning instead
        }
      }
      if (ds && ds.type === 'selectionDrag') {
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
          if (sx !== n.x || sy !== n.y || sw !== n.width || sh !== n.height) {
            onUpdateNode(ds.nodeId, { x: sx, y: sy, width: sw, height: sh });
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
                const NEW_W = 220;
                const NEW_H = 60;
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
  }, [onUpdateViewport, onUpdateNode, onAddArrow, onAddNode, onAddStroke, onMoveSelection, onSelectionDragEnd, onNodeDragEnd, onSelectionChange]);

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
    onAddNode(snap(world.x - 110), snap(world.y - 30));
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
    const ahSize = vpRef.current.zoom < 0.4 ? 16 : 10;
    const liveNodes = { ...allNodes, [nodeId]: draggedSnap };
    const resolvePos = (arrow, end) => resolveEndpoint(arrow, end, liveNodes, allArrows, heights, EDGE_KINDS, regionsRef.current);
    for (const aId of st.affectedArrows) {
      const a = allArrows[aId];
      if (!a) continue;
      const from = resolvePos(a, 'from');
      const to   = resolvePos(a, 'to');
      if (!from || !to) continue;
      const { path, cp1x, cp1y, cp2x, cp2y, midX, midY } = bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, a.fromCtrl, a.toCtrl);
      const g = arrowGsRef.current[aId];
      if (!g) continue;
      const paths = g.querySelectorAll(':scope > path');
      for (const p of paths) p.setAttribute('d', path);
      const polygons = g.querySelectorAll('polygon.arrow-marker');
      if (polygons.length >= 1) polygons[0].setAttribute('points', arrowheadPoints(to.x, to.y, cp2x, cp2y, ahSize));
      if (polygons.length >= 2) polygons[1].setAttribute('points', arrowheadPoints(from.x, from.y, cp1x, cp1y, ahSize));
      const aKindDef2 = a.kind ? EDGE_KINDS[a.kind] : null;
      let mt2 = `translate(${midX} ${midY})`;
      if (aKindDef2 && aKindDef2.rotateWithFlow) {
        const ang = Math.atan2(cp2y - cp1y, cp2x - cp1x) * 180 / Math.PI;
        mt2 += ` rotate(${ang})`;
      }
      const midGroups = g.querySelectorAll(':scope > g');
      for (const mg of midGroups) mg.setAttribute('transform', mt2);
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
    const newPanX = vp.panX + dx;
    const newPanY = vp.panY + dy;
    vpRef.current = { ...vp, panX: newPanX, panY: newPanY };
    if (transformRef.current) {
      transformRef.current.style.transform = `translate(${newPanX}px, ${newPanY}px) scale(${vp.zoom})`;
    }
    const gridEl = rootRef.current?.querySelector('.canvas-grid');
    if (gridEl) {
      const gs = GRID_SIZE * vp.zoom;
      gridEl.style.backgroundPosition = `${newPanX % gs}px ${newPanY % gs}px`;
    }
  }, []);
  const kbPanCommit = useCallback(() => {
    onUpdateViewport({ ...vpRef.current });
  }, [onUpdateViewport]);

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
    const newPanX = cx - (cx - vp.panX) * scale;
    const newPanY = cy - (cy - vp.panY) * scale;
    vpRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
    if (transformRef.current) {
      transformRef.current.style.transform = `translate(${newPanX}px, ${newPanY}px) scale(${newZoom})`;
    }
    const gridEl = rootRef.current?.querySelector('.canvas-grid');
    if (gridEl) {
      const gs = GRID_SIZE * newZoom;
      gridEl.style.backgroundPosition = `${newPanX % gs}px ${newPanY % gs}px`;
      gridEl.style.backgroundSize = `${gs}px ${gs}px`;
    }
  }, []);
  const kbZoomCommit = useCallback(() => {
    onUpdateViewport({ ...vpRef.current });
  }, [onUpdateViewport]);

  // Expose the imperative API to App via the ref prop.
  useEffect(() => {
    if (!kbNudgeApiRef) return;
    kbNudgeApiRef.current = {
      nudge: kbNudgeNode, commit: kbCommitNode,
      pan: kbPan, panCommit: kbPanCommit,
      zoom: kbZoom, zoomCommit: kbZoomCommit,
    };
    return () => {
      if (kbNudgeApiRef) kbNudgeApiRef.current = {};
    };
  }, [kbNudgeApiRef, kbNudgeNode, kbCommitNode, kbPan, kbPanCommit, kbZoom, kbZoomCommit]);

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
    const { path, cp1x, cp1y, cp2x, cp2y, midX, midY } = isElbow
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
    const arrowsMode = dirLocked
      ? (kindDef.arrows || 'forward')
      : (arrow.direction || (arrow.bidirectional ? 'both' : (kindDef ? (kindDef.arrows || 'forward') : 'forward')));
    // Dash style: 0/undefined solid, 1 small dashes, 2 large dashes.
    const dashArr = arrow.dash === 1 ? '7 5' : arrow.dash === 2 ? '14 9' : null;
    // Operator pill — single symbol (∧ / ∨ / ⇒ / ⇔).
    const opText = kindDef && kindDef.render === 'text' ? kindDef.symbol : null;
    const pillW = 40;
    const pillH = 30;
    // Rotate directional glyphs (⇒ ⇔ ⊢ ⇀ ≡) along the bezier tangent at
    // the midpoint, so a vertical curve gets the symbol turned 90°.
    const midAngleDeg = (kindDef && kindDef.rotateWithFlow)
      ? Math.atan2(cp2y - cp1y, cp2x - cp1x) * 180 / Math.PI
      : 0;
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
          d={path}
          className="arrow-path-hit"
          fill="none"
          onClick={(e) => onArrowClick(e, aId)}
          onDoubleClick={(e) => onArrowDoubleClick(e, aId)}
        />
        <path
          d={path}
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
            <rect
              x={-pillW / 2} y={-pillH / 2}
              width={pillW} height={pillH}
              rx={pillH / 2} ry={pillH / 2}
              fill="#0e0e10" stroke={color} strokeWidth={2}
            />
            {kindDef.icon ? (
              <path d={kindDef.icon} fill="none" stroke={color} strokeWidth={1.8}
                strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
            ) : arrow.kind === 'xor' ? (
              /* XOR — a circle quartered by a full-diameter cross. */
              <g pointerEvents="none">
                <circle r={9} fill="none" stroke={color} strokeWidth={2} />
                <line x1={-9} y1={0} x2={9} y2={0} stroke={color} strokeWidth={2} />
                <line x1={0} y1={-9} x2={0} y2={9} stroke={color} strokeWidth={2} />
              </g>
            ) : (
              <text
                x={0} y={2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                pointerEvents="none"
                style={{ font: '700 22px ui-sans-serif, system-ui, sans-serif' }}
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
                fill="#0e0e10" stroke={color} strokeWidth={1.8}
              />
            ) : (
              <circle r={15} fill="#0e0e10" stroke={color} strokeWidth={1.8} />
            )}
            {/* Glyph icon — shifted into the left half for weighted pills. */}
            <g transform={kindDef.weighted ? `translate(${-pillBounds.halfW + 15} 0)` : undefined}>
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
      left: node.x,
      top: node.y,
      width: node.width || 220,
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
          <div className="node-not-badge" title="Negated (NOT)">¬</div>
        )}
        {/* Probability — editable percentage in top-right corner. Sits left of
            the NOT badge when both are enabled. */}
        {node.probability != null && (
          <div
            className={`node-prob-pill${node.negated ? ' offset-not' : ''}`}
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
              const el = e.target.closest('.wb-node');
              if (el) {
                el.style.minHeight = 'auto';
                const natural = el.offsetHeight;
                // Grow to fit content, but never shrink below the node's set
                // height — so figures and resized nodes don't collapse when
                // you start typing into them. snap() the floor so a stray
                // fractional height can't propagate through the grow path.
                const floor = Math.max(60, snap(node.height || 0));
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
                if (newY !== node.y) onUpdateNode(node.id, { height: snapped, y: newY });
                else onUpdateNode(node.id, { height: snapped });
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
    : (toolMode === 'node' || toolMode === 'region' || toolMode === 'figure') ? ' place-mode'
    : '';

  // Compute stroke selection bounding box for visual indicator
  const strokeSelBounds = (selection.strokeIds.size > 0)
    ? getSelectionBounds({ nodeIds: new Set(), strokeIds: selection.strokeIds }, {}, drawStrokes, nodeHeightMap)
    : null;

  return (
    <div
      ref={rootRef}
      className={`canvas-root${isOverview ? ' overview' : ''}${cursorClass}`}
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
        {/* Regions layer */}
        <div className="region-layer">
          {Object.values(regions).map((region) => {
            const isRegionSelected = (selectedType === 'region' && selectedId === region.id) || (selection.regionIds && selection.regionIds.has(region.id));
            const color = region.color || '#cf7bf0';
            return (
              <div key={region.id} className={`wb-region${isRegionSelected ? ' selected' : ''}${region.locked ? ' locked' : ''}${region.noFill ? ' no-fill' : ''}`}
                style={{ left: region.x, top: region.y, width: region.w, height: region.h, '--region-color': color,
                  // In select mode the body is grabbable (move) — unless locked,
                  // in which case the interior passes clicks through so you can
                  // work freely inside without nudging the region.
                  pointerEvents: (toolMode === 'select' && !region.locked) ? 'auto' : undefined }}
                onMouseDown={(e) => { if (toolMode === 'select') onRegionBorderMouseDown(e, region.id); }}>
                <span className="region-label" contentEditable suppressContentEditableWarning style={{ color }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={(e) => onUpdateRegionRef.current(region.id, { label: e.target.textContent || '' })}>
                  {region.label || ''}
                </span>
                {region.locked && (
                  <div className="region-lock" style={{ color }} title="Locked — click to select & unlock"
                    onMouseDown={(e) => { e.stopPropagation(); onSelect(region.id, 'region'); }}>
                    🔒
                  </div>
                )}
                {!region.locked && (
                  <div className="region-border-hit" onMouseDown={(e) => onRegionBorderMouseDown(e, region.id)} />
                )}
                {ANCHORS.map((a) => (
                  <div
                    key={a}
                    className={`region-anchor-dot ${a}`}
                    style={{ background: color }}
                    onMouseDown={(e) => onRegionAnchorMouseDown(e, region.id, a)}
                  />
                ))}
                {isRegionSelected && !region.locked && ['nw', 'ne', 'sw', 'se'].map((corner) => (
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
          {/* Persisted strokes — gel-pen fill outlines */}
          {drawStrokes && drawStrokes
            // Defensive: drop any duplicate-id strokes so React keys stay
            // unique (a corrupted board could carry dupes from older sessions).
            .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i)
            .map((stroke) => (
            <g
              key={stroke.id}
              onMouseDown={(e) => {
                if (toolMode !== 'select') return;
                e.stopPropagation();
                onSelect(null, null);
                // Keep a multi-selection if this stroke is already part of one;
                // otherwise select just this stroke.
                if (!selection.strokeIds.has(stroke.id)) {
                  onSelectionChange({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set([stroke.id]) });
                }
                // Start a move drag immediately (drag to reposition the stroke).
                const rect = rootRef.current.getBoundingClientRect();
                const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
                dragState.current = {
                  type: 'selectionDrag',
                  startWorldX: world.x, startWorldY: world.y,
                  lastWorldX: world.x, lastWorldY: world.y,
                };
              }}
            >
              {/* Wide invisible hit band along the centerline — makes thin
                  strokes easy to click without changing how they look. */}
              <path
                d={pointsToPath(stroke.points)}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(16, stroke.width || 2)}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: toolMode === 'select' ? 'stroke' : 'none', cursor: 'pointer' }}
              />
              <path
                d={gelStrokePath(stroke.points, stroke.width)}
                className={`freehand-stroke gel${selection.strokeIds.has(stroke.id) ? ' in-selection' : ''}`}
                fill={stroke.color || '#cf7bf0'}
                fillOpacity={(stroke.opacity == null ? 100 : stroke.opacity) / 100}
                stroke="none"
                style={{ pointerEvents: 'none' }}
              />
            </g>
          ))}
          {/* Live preview while drawing */}
          {drawingPreview && currentStroke.current && (
            <path
              d={drawingPreview}
              className="freehand-stroke gel"
              fill={currentStroke.current.color || '#cf7bf0'}
              fillOpacity={(currentStroke.current.opacity == null ? 100 : currentStroke.current.opacity) / 100}
              stroke="none"
              opacity={0.7}
            />
          )}
        </svg>

        {/* Eraser hit layer - catches mouse events in eraser mode */}
        {toolMode === 'eraser' && (
          <div className="eraser-hit-layer" />
        )}

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

        {/* Stroke selection bounding box */}
        {strokeSelBounds && (
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
