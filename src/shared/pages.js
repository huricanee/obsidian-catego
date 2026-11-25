/**
 * Paged-document mode ("sheets", as in a notebook app) — pure geometry.
 *
 * A board is either infinite (state.doc == null) or a document:
 *   doc = { paper, w, h, bg, x, y }
 * Pages are stacked vertically from the origin (doc.x, doc.y), PAGE_GAP apart.
 * The page COUNT is not stored: it is derived from the content — there is
 * always exactly one blank page after the last page that has something on it.
 */
export const PAGE_GAP = 40;
export const PAGE_MARGIN = 40; // screen px kept around the document when clamping
export const PAGE_OVERSCROLL = 0.35; // share of the view height the document may be pulled past its ends

// World units are px at zoom 1; sizes are multiples of the 20px grid.
export const PAPERS = {
  a4: { w: 820, h: 1160, label: 'A4' },
  a4l: { w: 1160, h: 820, label: 'A4 landscape' },
  letter: { w: 820, h: 1060, label: 'Letter' },
  wide: { w: 1280, h: 800, label: '16:10' },
};
export const PAGE_BGS = ['blank', 'ruled', 'grid', 'dots'];

export function makeDoc(paper = 'a4', bg = 'ruled', origin = null) {
  const p = PAPERS[paper] || PAPERS.a4;
  return {
    paper: PAPERS[paper] ? paper : 'a4',
    w: p.w, h: p.h,
    bg: PAGE_BGS.includes(bg) ? bg : 'ruled',
    x: origin ? origin.x : 0,
    y: origin ? origin.y : 0,
  };
}

/** Accepts anything loaded from storage; returns a valid doc or null. */
export function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const base = makeDoc(doc.paper, doc.bg, { x: Number(doc.x) || 0, y: Number(doc.y) || 0 });
  const w = Number(doc.w), h = Number(doc.h);
  if (w >= 200 && h >= 200) { base.w = w; base.h = h; }
  return base;
}

// A stroke's bounding box never changes while the object is the same (every
// edit makes a new stroke object), so cache it per object.
const strokeBox = new WeakMap();
export function boxOfStroke(s) {
  let b = strokeBox.get(s);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.points || []) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  b = { x0, y0, x1, y1 };
  strokeBox.set(s, b);
  return b;
}

/** Bounding box of everything on the board, or null when it is empty. */
export function contentBounds(state) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (ax, ay, bx, by) => {
    if (ax < x0) x0 = ax;
    if (ay < y0) y0 = ay;
    if (bx > x1) x1 = bx;
    if (by > y1) y1 = by;
  };
  for (const n of Object.values(state.nodes || {})) add(n.x, n.y, n.x + (n.width || 220), n.y + (n.height || 60));
  for (const r of Object.values(state.regions || {})) add(r.x, r.y, r.x + r.w, r.y + r.h);
  for (const s of state.strokes || []) {
    const b = boxOfStroke(s);
    if (b.x0 !== Infinity) add(b.x0, b.y0, b.x1, b.y1);
  }
  for (const a of Object.values(state.arrows || {})) {
    for (const p of [a.fromPoint, a.toPoint]) if (p) add(p.x, p.y, p.x, p.y);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** Resolved layout: the page rectangles plus the area the view may roam. */
export function docLayout(doc, state) {
  if (!doc) return null;
  const pitch = doc.h + PAGE_GAP;
  const cb = contentBounds(state);
  const lastUsed = cb ? Math.max(0, Math.floor((cb.y1 - doc.y) / pitch)) : -1;
  const count = Math.max(1, lastUsed + 2);
  const pages = [];
  for (let i = 0; i < count; i++) pages.push({ x: doc.x, y: doc.y + i * pitch, w: doc.w, h: doc.h });
  const bounds = { x0: doc.x, y0: doc.y, x1: doc.x + doc.w, y1: doc.y + count * pitch - PAGE_GAP };
  // Content that lies off the sheets (a board converted from infinite mode)
  // must stay reachable.
  if (cb) {
    bounds.x0 = Math.min(bounds.x0, cb.x0);
    bounds.y0 = Math.min(bounds.y0, cb.y0);
    bounds.x1 = Math.max(bounds.x1, cb.x1);
    bounds.y1 = Math.max(bounds.y1, cb.y1);
  }
  return { ...doc, gap: PAGE_GAP, count, pages, bounds };
}

/** Keep the document on screen: no drifting off into empty space. */
export function clampViewport(vp, layout, viewW, viewH) {
  if (!layout || !viewW || !viewH) return vp;
  const { bounds } = layout;
  const z = vp.zoom;
  const M = PAGE_MARGIN;
  const range = (start, size, view) => {
    // pan such that the extent's start edge sits at M, or its end edge at view-M
    const a = M - start * z;
    const b = view - M - (start + size) * z;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const [loX, hiX] = range(bounds.x0, bounds.x1 - bounds.x0, viewW);
  // Vertically the document may be pulled a third of the screen past either
  // end, so the top (and the last line) can be brought to a comfortable height.
  const [loY0, hiY0] = range(bounds.y0, bounds.y1 - bounds.y0, viewH);
  const slack = viewH * PAGE_OVERSCROLL;
  const loY = loY0 - slack, hiY = hiY0 + slack;
  const panX = Math.min(hiX, Math.max(loX, vp.panX));
  const panY = Math.min(hiY, Math.max(loY, vp.panY));
  if (panX === vp.panX && panY === vp.panY) return vp;
  return { ...vp, panX, panY };
}

/** Viewport that shows page `index` at full width, top-aligned. */
export function fitPageViewport(layout, viewW, viewH, index = 0, maxZoom = 1.5) {
  const page = layout.pages[Math.min(index, layout.pages.length - 1)];
  const zoom = Math.max(0.1, Math.min(maxZoom, (viewW - 2 * PAGE_MARGIN) / page.w));
  return {
    zoom,
    panX: (viewW - page.w * zoom) / 2 - page.x * zoom,
    panY: PAGE_MARGIN - page.y * zoom,
  };
}

/** Index of the page under world-y `wy` (clamped to existing pages). */
export function pageIndexAt(layout, wy) {
  const i = Math.floor((wy - layout.y + layout.gap / 2) / (layout.h + layout.gap));
  return Math.max(0, Math.min(layout.count - 1, i));
}
