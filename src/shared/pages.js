/**
 * Paged-document mode ("sheets", as in a notebook app) — pure geometry.
 *
 * A board is either infinite (state.doc == null) or a document:
 *   doc = { paper, w, h, bg, x, y, bgs? }
 * Pages are stacked vertically from the origin (doc.x, doc.y), PAGE_GAP apart.
 * The page COUNT is not stored: it is derived from the content — there is
 * always exactly one blank page after the last page that has something on it.
 *
 * doc.bgs = { [pageIndex]: { src, page } } — a page printed on that sheet: page
 * `page` (1-based) of the PDF stored as asset `src` (an imported PDF you write
 * over). A sheet with a background counts as used.
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
  const bgs = normalizeBgs(doc.bgs);
  if (bgs) base.bgs = bgs;
  return base;
}

function normalizeBgs(bgs) {
  if (!bgs || typeof bgs !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(bgs)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || !v || typeof v.src !== 'string') continue;
    out[i] = { src: v.src, page: Math.max(1, Number(v.page) || 1) };
  }
  return Object.keys(out).length ? out : null;
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
  let lastUsed = cb ? Math.max(0, Math.floor((cb.y1 - doc.y) / pitch)) : -1;
  for (const k of Object.keys(doc.bgs || {})) lastUsed = Math.max(lastUsed, Number(k));
  const count = Math.max(1, lastUsed + 2);
  const pages = [];
  for (let i = 0; i < count; i++) {
    const pg = { x: doc.x, y: doc.y + i * pitch, w: doc.w, h: doc.h };
    if (doc.bgs && doc.bgs[i]) pg.bg = doc.bgs[i];
    pages.push(pg);
  }
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

/* ----------------------------------------------------------------
   Page operations — pure: (state) → { nodes, arrows, regions, strokes, doc }.
   An object belongs to the page its centre is on. Stroke objects are
   immutable: a moved stroke is a new object.
   ---------------------------------------------------------------- */
const pitchOf = (doc) => doc.h + PAGE_GAP;
function rawPageIndex(doc, wy) {
  return Math.max(0, Math.floor((wy - doc.y + PAGE_GAP / 2) / pitchOf(doc)));
}
const nodeCy = (n) => n.y + (n.height || 60) / 2;
const strokeCy = (s) => { const b = boxOfStroke(s); return (b.y0 + b.y1) / 2; };
const moveStroke = (s, dy) => (dy ? { ...s, points: (s.points || []).map((p) => ({ ...p, y: p.y + dy })) } : s);

/**
 * Re-place every object: `dyFor(cy)` → vertical shift, or null to delete it.
 * Arrows attached to a deleted node / region go with it; free arrow ends move
 * on their own.
 */
function remap(state, dyFor) {
  const nodes = {}, regions = {}, arrows = {};
  const gone = new Set();
  for (const n of Object.values(state.nodes || {})) {
    const dy = dyFor(nodeCy(n));
    if (dy == null) { gone.add(n.id); continue; }
    nodes[n.id] = dy ? { ...n, y: n.y + dy } : n;
  }
  for (const r of Object.values(state.regions || {})) {
    const dy = dyFor(r.y + r.h / 2);
    if (dy == null) { gone.add(r.id); continue; }
    regions[r.id] = dy ? { ...r, y: r.y + dy } : r;
  }
  const strokes = [];
  for (const s of state.strokes || []) {
    const b = boxOfStroke(s);
    if (b.y0 === Infinity) { strokes.push(s); continue; }
    const dy = dyFor(strokeCy(s));
    if (dy != null) strokes.push(moveStroke(s, dy));
  }
  const src = Object.values(state.arrows || {});
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const a of src) {
      if (gone.has(a.id)) continue;
      const refs = [a.fromNodeId, a.toNodeId, a.fromRegionId, a.toRegionId, a.fromPillArrowId, a.toPillArrowId];
      let dead = refs.some((id) => id && gone.has(id));
      const pt = (p) => {
        if (!p) return p;
        const dy = dyFor(p.y);
        if (dy == null) { dead = true; return p; }
        return dy ? { ...p, y: p.y + dy } : p;
      };
      const fromPoint = pt(a.fromPoint), toPoint = pt(a.toPoint);
      if (dead) { gone.add(a.id); delete arrows[a.id]; grew = true; continue; }
      arrows[a.id] = (fromPoint !== a.fromPoint || toPoint !== a.toPoint) ? { ...a, fromPoint, toPoint } : a;
    }
    if (!grew) break;
  }
  return { nodes, arrows, regions, strokes };
}

function remapBgs(doc, indexFor) {
  if (!doc.bgs) return doc;
  const bgs = {};
  for (const [k, v] of Object.entries(doc.bgs)) {
    const i = indexFor(Number(k));
    if (i != null) bgs[i] = v;
  }
  const next = { ...doc };
  if (Object.keys(bgs).length) next.bgs = bgs; else delete next.bgs;
  return next;
}

/** Blank sheet before page `index` (0-based); everything from there moves down. */
export function insertPage(state, index) {
  const doc = state.doc; if (!doc) return null;
  const P = pitchOf(doc);
  return {
    ...remap(state, (cy) => (rawPageIndex(doc, cy) >= index ? P : 0)),
    doc: remapBgs(doc, (i) => (i >= index ? i + 1 : i)),
  };
}

/** Remove page `index` with everything on it; later pages move up. */
export function deletePage(state, index) {
  const doc = state.doc; if (!doc) return null;
  const P = pitchOf(doc);
  return {
    ...remap(state, (cy) => { const i = rawPageIndex(doc, cy); return i === index ? null : i > index ? -P : 0; }),
    doc: remapBgs(doc, (i) => (i === index ? null : i > index ? i - 1 : i)),
  };
}

/** Move page `from` so that it becomes page `to`. */
export function movePage(state, from, to) {
  const doc = state.doc; if (!doc || from === to) return null;
  const P = pitchOf(doc);
  const idx = (i) => {
    if (i === from) return to;
    if (from < to && i > from && i <= to) return i - 1;
    if (from > to && i >= to && i < from) return i + 1;
    return i;
  };
  return {
    ...remap(state, (cy) => { const i = rawPageIndex(doc, cy); return (idx(i) - i) * P; }),
    doc: remapBgs(doc, idx),
  };
}

/** Copy page `index` into a new page right after it. `genId(prefix)` makes ids. */
export function duplicatePage(state, index, genId) {
  const doc = state.doc; if (!doc) return null;
  const P = pitchOf(doc);
  const base = insertPage(state, index + 1);
  const on = (cy) => rawPageIndex(doc, cy) === index;
  const idMap = {};
  for (const n of Object.values(state.nodes || {})) {
    if (!on(nodeCy(n))) continue;
    const id = genId('n'); idMap[n.id] = id;
    base.nodes[id] = { ...n, id, y: n.y + P };
  }
  for (const r of Object.values(state.regions || {})) {
    if (!on(r.y + r.h / 2)) continue;
    const id = genId('r'); idMap[r.id] = id;
    base.regions[id] = { ...r, id, y: r.y + P };
  }
  for (const s of state.strokes || []) {
    const b = boxOfStroke(s);
    if (b.y0 === Infinity || !on(strokeCy(s))) continue;
    base.strokes.push({ ...moveStroke(s, P), id: genId('s') });
  }
  for (const a of Object.values(state.arrows || {})) {
    const refs = [a.fromNodeId, a.toNodeId, a.fromRegionId, a.toRegionId].filter(Boolean);
    const pts = [a.fromPoint, a.toPoint].filter(Boolean);
    if (a.fromPillArrowId || a.toPillArrowId || (a.participants && a.participants.length)) continue;
    if (!refs.length && !pts.length) continue;
    if (!refs.every((id) => idMap[id]) || !pts.every((p) => on(p.y))) continue;
    const id = genId('a');
    const m = (v) => (v ? idMap[v] : v);
    const mp = (p) => (p ? { ...p, y: p.y + P } : p);
    base.arrows[id] = { ...a, id, fromNodeId: m(a.fromNodeId), toNodeId: m(a.toNodeId), fromRegionId: m(a.fromRegionId), toRegionId: m(a.toRegionId), fromPoint: mp(a.fromPoint), toPoint: mp(a.toPoint) };
  }
  if (doc.bgs && doc.bgs[index]) base.doc = { ...base.doc, bgs: { ...(base.doc.bgs || {}), [index + 1]: doc.bgs[index] } };
  return base;
}

/**
 * "Add space": everything that starts at or below world-y `y0` moves by `dy`
 * (negative = close a gap). Page backgrounds stay where they are.
 */
export function shiftBelow(state, y0, dy) {
  if (!dy) return null;
  const nodes = {}, regions = {}, arrows = {};
  for (const n of Object.values(state.nodes || {})) nodes[n.id] = n.y >= y0 ? { ...n, y: n.y + dy } : n;
  for (const r of Object.values(state.regions || {})) regions[r.id] = r.y >= y0 ? { ...r, y: r.y + dy } : r;
  const strokes = (state.strokes || []).map((s) => (boxOfStroke(s).y0 >= y0 ? moveStroke(s, dy) : s));
  for (const a of Object.values(state.arrows || {})) {
    const mp = (p) => (p && p.y >= y0 ? { ...p, y: p.y + dy } : p);
    const fromPoint = mp(a.fromPoint), toPoint = mp(a.toPoint);
    arrows[a.id] = (fromPoint !== a.fromPoint || toPoint !== a.toPoint) ? { ...a, fromPoint, toPoint } : a;
  }
  return { nodes, arrows, regions, strokes, doc: state.doc || null };
}

/** The board with only the ink that can be seen inside world rect `r` (one-page renders). */
export function sliceRect(state, r) {
  const x1 = r.x + r.w, y1 = r.y + r.h;
  const strokes = (state.strokes || []).filter((s) => {
    const b = boxOfStroke(s); const m = (s.width || 2) * 2;
    return b.y0 !== Infinity && b.x1 + m >= r.x && b.x0 - m <= x1 && b.y1 + m >= r.y && b.y0 - m <= y1;
  });
  return { ...state, strokes };
}

/** Which page (0-based) an object with centre world-y `cy` is on. */
export function pageOfY(doc, cy) { return rawPageIndex(doc, cy); }
