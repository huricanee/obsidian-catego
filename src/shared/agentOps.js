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

const snap = (v) => Math.round((Number(v) || 0) / 20) * 20;

/** → { state, applied: [opId], changed } — pure. `done` = ids applied earlier. */
export function applyAgentOps(state, ops, done = []) {
  const seen = new Set(done);
  const applied = [];
  let st = { nodes: state.nodes || {}, arrows: state.arrows || {}, regions: state.regions || {}, strokes: state.strokes || [], doc: state.doc || null };
  let changed = false;
  const origin = (page) => {
    if (!st.doc) return { x: 0, y: 0 };
    const lay = docLayout(st.doc, st);
    let i = page === 'new' || page == null ? lay.count - 1 : Math.max(0, Math.floor(Number(page)) - 1 || 0);
    i = Math.min(i, lay.count - 1);
    return { x: lay.pages[i].x, y: lay.pages[i].y };
  };
  for (const op of ops || []) {
    if (!op || seen.has(op.id)) continue;
    seen.add(op.id);
    applied.push(op.id);
    const id = `ag_${op.id}`;
    if (op.op === 'text' || op.op === 'node' || op.op === 'image') {
      if (st.nodes[id]) continue;
      const o = origin(op.page);
      const node = { id, x: snap(o.x + (Number(op.x) || 0)), y: snap(o.y + (Number(op.y) || 0)), text: String(op.text || ''), color: op.color || '#ffffff', agent: true };
      if (op.op === 'text') {
        node.style = 'text';
        node.width = Math.max(60, snap(op.w || 400));
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
