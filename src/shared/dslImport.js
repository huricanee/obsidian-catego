/**
 * DSL → Catego objects. Parses the DSL, lays the graph out with dagre
 * (hierarchical top-to-bottom), and returns ready-to-insert node/arrow objects
 * (real ids, grid-snapped positions, anchors derived from layout).
 */
import dagre from '@dagrejs/dagre';
import { parseDsl } from './dsl.js';

const GRID = 20;
const snap = (v) => Math.round(v / GRID) * GRID;

// Rough size estimate for layout spacing (Catego auto-measures height after
// the nodes are created; this just needs to be in the right ballpark).
function estimateSize(node) {
  const w = node.w ? node.w : 220;          // (WxH) is in pixels (matches serializer)
  if (node.h) return { w, h: node.h };
  const perLine = Math.max(8, Math.floor((w - 32) / 8.5));
  const explicit = String(node.text || '').split('\n');
  let lines = 0;
  for (const ln of explicit) lines += Math.max(1, Math.ceil(ln.length / perLine));
  return { w, h: Math.max(60, snap(lines * 22 + 28)) };
}

// Pick from/to anchors from the centres' dominant axis after layout.
function anchorsFor(fromC, toC) {
  const dx = toC.x - fromC.x, dy = toC.y - fromC.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

/**
 * @param text   DSL source
 * @param genId  () => unique Catego id (node), (prefix) => id
 * @param origin { x, y } world point the graph's top-left should land near
 * @returns { nodes: [...], arrows: [...], errors: [...], count }
 */
export function buildGraphFromDsl(text, genId, origin = { x: 0, y: 0 }) {
  const parsed = parseDsl(text);
  // Regions carry explicit coordinates — they don't go through dagre.
  const regionRef = {};   // dsl id -> catego id
  const centre = {};      // dsl id -> world centre (for anchors); nodes + regions
  const regions = (parsed.regions || []).map((r) => {
    const cid = genId('r');
    const x = snap(r.x), y = snap(r.y), w = snap(r.w), h = snap(r.h);
    regionRef[r.id] = cid;
    centre[r.id] = { x: x + w / 2, y: y + h / 2 };
    return { id: cid, x, y, w, h, color: r.color || '#cf7bf0', fill: !!r.fill, label: r.label || '' };
  });

  if (!parsed.nodes.length) {
    return { nodes: [], arrows: [], regions, errors: parsed.errors, count: regions.length };
  }

  // Nodes with explicit coordinates (figures, or a node with @x,y) are placed
  // literally and bypass dagre; the rest are laid out hierarchically.
  const isPlaced = (n) => !!n.shape || (n.x != null && n.y != null);
  const flow = parsed.nodes.filter((n) => !isPlaced(n));

  // Formulas read left→right (P, Q → ∧ → ⇒ → R), arguments top→down.
  const opById = Object.fromEntries(parsed.edges.filter((e) => e.operator && e.id).map((e) => [e.id, e]));
  const hasOps = Object.keys(opById).length > 0;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: hasOps ? 'LR' : 'TB', nodesep: 50, ranksep: hasOps ? 100 : 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const sizes = {};
  for (const n of flow) {
    const s = estimateSize(n);
    sizes[n.id] = s;
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  // Operators take part in the layout as pseudo-nodes (a pill's footprint), so
  // a chain like `and(p,q)` → `implies(pq, r)` gets its own rank per operator
  // instead of all its pills piling up between two nodes.
  const inLayout = (id) => sizes[id] || opById[id];
  for (const id of Object.keys(opById)) g.setNode(id, { width: 44, height: 34 });
  for (const e of parsed.edges) {
    if (e.operator && e.id) {
      for (const m of [e.from, e.to, ...(e.participants || [])]) if (inLayout(m) && m !== e.id) g.setEdge(m, e.id);
    } else if (inLayout(e.from) && inLayout(e.to) && e.from !== e.to) {
      g.setEdge(e.from, e.to);
    }
  }
  dagre.layout(g);

  // Bounding box of dagre-laid nodes → translate so they start at `origin`.
  let minX = Infinity, minY = Infinity;
  for (const n of flow) {
    const gn = g.node(n.id);
    minX = Math.min(minX, gn.x - sizes[n.id].w / 2);
    minY = Math.min(minY, gn.y - sizes[n.id].h / 2);
  }
  const offX = flow.length ? origin.x - minX : 0;
  const offY = flow.length ? origin.y - minY : 0;

  // Build Catego nodes with fresh ids.
  const idMap = {};       // dsl id -> catego id (nodes)
  const nodes = [];
  for (const n of parsed.nodes) {
    let x, y, w, h;
    if (n.shape) {
      x = snap(n.x); y = snap(n.y); w = snap(n.w); h = snap(n.h); // figure: pixel size
    } else if (n.x != null && n.y != null) {
      const s = estimateSize(n); x = snap(n.x); y = snap(n.y); w = s.w; h = s.h;
    } else {
      const gn = g.node(n.id), s = sizes[n.id];
      x = snap(gn.x - s.w / 2 + offX); y = snap(gn.y - s.h / 2 + offY); w = s.w; h = s.h;
    }
    const cid = genId();
    idMap[n.id] = cid;
    centre[n.id] = { x: x + w / 2, y: y + h / 2 };
    const node = { id: cid, x, y, width: w, height: h, text: n.text, color: n.color || '#cf7bf0' };
    if (n.shape) node.shape = n.shape;
    if (n.kind) node.kind = n.kind;
    if (n.status) node.status = n.status;
    if (n.negated) node.negated = true;
    if (n.probability != null) node.probability = n.probability;
    nodes.push(node);
  }

  // Operator pills get their arrow ids up front, so an operator may reference
  // another operator (nesting = parentheses) whatever the line order.
  const opCid = {};
  for (const e of parsed.edges) if (e.operator && e.id) opCid[e.id] = genId('a');
  // Resolve a DSL endpoint id → { kind: 'node' | 'region' | 'pill', cid }.
  const resolve = (id) => idMap[id] ? { kind: 'node', cid: idMap[id] }
    : regionRef[id] ? { kind: 'region', cid: regionRef[id] }
    : opCid[id] ? { kind: 'pill', cid: opCid[id] } : null;
  // A pill sits at the midpoint of its operator's base endpoints.
  const centreOf = (id, depth = 0) => {
    if (centre[id]) return centre[id];
    const op = opById[id];
    if (!op || depth > 8) return null;
    const a = centreOf(op.from, depth + 1), b = centreOf(op.to, depth + 1);
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };

  // Build Catego arrows.
  const arrows = [];
  for (const e of parsed.edges) {
    const rf = resolve(e.from), rt = resolve(e.to);
    if (!rf || !rt) continue;
    const fc = centreOf(e.from), tc = centreOf(e.to);
    let a = fc && tc ? anchorsFor(fc, tc) : { from: 'right', to: 'left' };
    // An operator over two nodes of the same column (P over Q): leave both by
    // the right side so the pill sits beside the column, where the next
    // operator in the chain picks it up — not on the nodes' border.
    if (e.operator && hasOps && fc && tc && Math.abs(fc.x - tc.x) < 1) a = { from: 'right', to: 'right' };
    const id = e.operator && e.id ? opCid[e.id] : genId('a');
    const arrow = {
      id,
      fromNodeId: rf.kind === 'node' ? rf.cid : null, fromAnchor: a.from,
      toNodeId: rt.kind === 'node' ? rt.cid : null, toAnchor: a.to,
      fromPillArrowId: rf.kind === 'pill' ? rf.cid : null, toPillArrowId: rt.kind === 'pill' ? rt.cid : null,
      fromRegionId: rf.kind === 'region' ? rf.cid : null, toRegionId: rt.kind === 'region' ? rt.cid : null,
      fromPoint: null, toPoint: null,
      color: '#cf7bf0',
    };
    if (e.kind) arrow.kind = e.kind;
    if (e.negated) arrow.negated = true;
    if (e.label) arrow.label = e.label;
    if (e.weight != null) arrow.probWeight = Math.min(100, e.weight);
    // Operators lock direction; only set an override for non-operator edges.
    if (!e.operator && e.direction && e.direction !== 'forward') arrow.direction = e.direction;
    // n-ary operator participants: extra endpoints folded into the pill.
    // Anchor each toward the pill centre (midpoint of the base from/to).
    const parts = (e.participants || []).filter((p) => idMap[p]);
    if (parts.length && fc && tc) {
      const pill = { x: (fc.x + tc.x) / 2, y: (fc.y + tc.y) / 2 };
      arrow.participants = parts.map((p) => ({
        nodeId: idMap[p],
        anchor: anchorsFor(centre[p], pill).from,
      }));
    }
    arrows.push(arrow);
  }

  return { nodes, arrows, regions, errors: parsed.errors, count: nodes.length + regions.length };
}
