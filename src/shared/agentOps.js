/**
 * Agent inbox — how an AI working on the files writes to a board without
 * touching the board file itself.
 *
 * The board file (`Name.catego`) has ONE writer: the editor. An agent appends
 * operations to a sidecar file (`Name.agent.json`, written by cli/catego.mjs);
 * the editor applies each operation once and remembers its id in the board
 * file (`extras.agentApplied`). Two writers never share a file, so file sync
 * has nothing to conflict on.
 *
 *   { "catego-agent": 1, "ops": [ { "id": "…", "op": "text", … }, … ] }
 *
 * Operations (page is 1-based; "new" = the blank sheet at the end; x / y are
 * measured from the sheet's top-left corner — on an infinite board, from the
 * origin):
 *   text   { page, x, y, w?, text, color?, size? }     free text (markdown, $LaTeX$)
 *   node   { page, x, y, w?, text, kind?, color? }     a node
 *   image  { page, x, y, w, src }                      a picture (asset path)
 *   page   { at }                                      blank sheet before page `at`
 *   delete { ids: [...] }                              remove objects by id
 *
 * An agent that can only write notes uses `Name.agent.md` instead — the same
 * operations as Markdown sections, no JSON escaping (see parseAgentMarkdown):
 *
 *   ## t1 page=new
 *   Find $\int_0^1 x^2\,dx$.
 *
 * Without `y` a block is placed under whatever is already on the page (on the
 * next sheet when the page is full); without `page`, on the last used page.
 *
 * Objects get deterministic ids (`ag_<opId>`), so applying the same op on two
 * devices converges instead of duplicating.
 */
import { docLayout, insertPage } from './pages.js';

export const AGENT_FILE_SUFFIX = '.agent.json';

export function parseAgentFile(text) {
  try {
    const j = JSON.parse(text);
    return j && Array.isArray(j.ops) ? j.ops.filter((o) => o && typeof o.id === 'string' && typeof o.op === 'string') : [];
  } catch { return []; }
}

export const AGENT_MD_SUFFIX = '.agent.md';

/**
 * `## <id> key=value …` starts an operation, the lines under it are its text.
 * `op` defaults to `text`; other keys: page, x, y, w, size, color, kind, src,
 * at, ids (comma-separated). An id is applied once — never reuse one.
 */
export function parseAgentMarkdown(text) {
  const ops = [];
  let cur = null, body = [];
  const flush = () => {
    if (!cur) return;
    const t = body.join('\n').trim();
    if (t && cur.text == null) cur.text = t;
    ops.push(cur);
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^##\s+(\S+)(.*)$/.exec(line);
    if (!m) { if (cur) body.push(line); continue; }
    flush();
    cur = { id: m[1], op: 'text' }; body = [];
    for (const kv of m[2].matchAll(/([a-z]+)=("[^"]*"|\S+)/gi)) {
      const k = kv[1].toLowerCase();
      const v = kv[2].replace(/^"|"$/g, '');
      if (k === 'ids') cur.ids = v.split(',').map((x) => x.trim()).filter(Boolean);
      else if (['x', 'y', 'w', 'h', 'size', 'at'].includes(k)) { if (Number.isFinite(Number(v))) cur[k] = Number(v); }
      else if (['op', 'page', 'color', 'kind', 'src'].includes(k)) cur[k] = v;
    }
  }
  flush();
  return ops;
}

const snap = (v) => Math.round((Number(v) || 0) / 20) * 20;

const MARGIN = 60;
// Height of a text block whose real height only the editor knows.
function estHeight(n) {
  if (n.height) return n.height;
  const w = (n.width || 220) - 16;
  const size = n.fontSize || 14;
  const perLine = Math.max(8, Math.floor(w / (size * 0.55)));
  const lines = String(n.text || '').split(/\n/).reduce((sum, ln) => sum + Math.max(1, Math.ceil(ln.length / perLine)), 0);
  return Math.max(n.style === 'text' ? 24 : 60, Math.ceil((lines * size * 1.5 + 12) / 20) * 20);
}

/** → { state, applied: [opId], changed } — pure. `done` = ids applied earlier. */
export function applyAgentOps(state, ops, done = []) {
  const seen = new Set(done);
  const applied = [];
  let st = { nodes: state.nodes || {}, arrows: state.arrows || {}, regions: state.regions || {}, strokes: state.strokes || [], doc: state.doc || null };
  let changed = false;
  const pageIndex = (lay, page) => {
    if (page === 'new' || page == null) return lay.count - 1;
    if (page === 'last') return Math.max(0, lay.count - 2);
    return Math.min(lay.count - 1, Math.max(0, Math.floor(Number(page)) - 1 || 0));
  };
  const origin = (page) => {
    if (!st.doc) return { x: 0, y: 0 };
    const lay = docLayout(st.doc, st);
    const pg = lay.pages[pageIndex(lay, page)];
    return { x: pg.x, y: pg.y };
  };
  // Lowest point of what lies between y0 and y1 (null = nothing there).
  const bottomIn = (y0, y1) => {
    let b = null;
    const see = (top, bot) => { if (bot > y0 && top < y1) b = b == null ? bot : Math.max(b, bot); };
    for (const n of Object.values(st.nodes)) see(n.y, n.y + estHeight(n));
    for (const r of Object.values(st.regions)) see(r.y, r.y + (r.height || 0));
    for (const s of st.strokes) for (const p of s.points || []) see(p.y, p.y);
    return b;
  };
  // No `y` given: under whatever is on the page, or on the next sheet when full.
  const autoPlace = (op) => {
    const x = op.x == null ? MARGIN : Number(op.x) || 0;
    if (!st.doc) {
      const b = bottomIn(-Infinity, Infinity);
      return { x, y: b == null ? 0 : b + 40, w: 700 };
    }
    const lay = docLayout(st.doc, st);
    let i = pageIndex(lay, op.page == null ? 'last' : op.page);
    for (;;) {
      const pg = lay.pages[i];
      const b = bottomIn(pg.y, pg.y + pg.h);
      const y = b == null ? MARGIN : b - pg.y + 40;
      const need = op.op === 'image' ? 200 : Math.min(400, estHeight({ text: op.text, width: op.w || pg.w - 2 * MARGIN, style: 'text', fontSize: op.size }));
      if (y + need <= pg.h - MARGIN || b == null || i >= lay.count - 1) return { x: pg.x + x, y: pg.y + y, w: pg.w - 2 * MARGIN - (x - MARGIN) };
      i += 1;
    }
  };
  for (const op of ops || []) {
    if (!op || seen.has(op.id)) continue;
    seen.add(op.id);
    applied.push(op.id);
    const id = `ag_${op.id}`;
    if (op.op === 'text' || op.op === 'node' || op.op === 'image') {
      if (st.nodes[id]) continue;
      const auto = op.y == null ? autoPlace(op) : null;
      const o = auto ? { x: 0, y: 0 } : origin(op.page);
      const node = { id, x: snap(o.x + (auto ? auto.x : Number(op.x) || 0)), y: snap(o.y + (auto ? auto.y : Number(op.y) || 0)), text: String(op.text || ''), color: op.color || '#ffffff', agent: true };
      if (op.op === 'text') {
        node.style = 'text';
        node.width = Math.max(60, snap(op.w || (auto ? auto.w : 400)));
        if (op.size) node.fontSize = Number(op.size);
      } else if (op.op === 'node') {
        node.width = Math.max(60, snap(op.w || 220));
        if (op.kind) node.kind = String(op.kind);
      } else {
        if (!op.src) continue;
        node.shape = 'image'; node.image = String(op.src); node.text = '';
        node.width = Math.max(40, snap(op.w || 320));
        node.height = Math.max(40, snap(op.h || node.width * 0.75));
        if (!op.h) node.fitImage = true; // proportions are fixed up when the picture loads
      }
      st = { ...st, nodes: { ...st.nodes, [id]: node } };
      changed = true;
    } else if (op.op === 'page') {
      if (!st.doc) continue;
      const lay = docLayout(st.doc, st);
      const at = Math.max(0, Math.min(lay.count - 1, (Math.floor(Number(op.at)) || lay.count) - 1));
      const res = insertPage(st, at);
      if (res) { st = res; changed = true; }
    } else if (op.op === 'delete') {
      const ids = new Set((op.ids || []).map(String));
      if (!ids.size) continue;
      const nodes = {}, regions = {}, arrows = {};
      for (const n of Object.values(st.nodes)) if (!ids.has(n.id)) nodes[n.id] = n;
      for (const r of Object.values(st.regions)) if (!ids.has(r.id)) regions[r.id] = r;
      for (const a of Object.values(st.arrows)) {
        if (ids.has(a.id) || ids.has(a.fromNodeId) || ids.has(a.toNodeId) || ids.has(a.fromRegionId) || ids.has(a.toRegionId)) continue;
        arrows[a.id] = a;
      }
      const strokes = st.strokes.filter((s) => !ids.has(s.id));
      st = { ...st, nodes, regions, arrows, strokes };
      changed = true;
    }
  }
  return { state: st, applied, changed };
}
