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
    return { id: cid, x, y, w, h, color: r.color || '#cf7bf0', locked: !!r.locked, noFill: !!r.noFill, label: r.label || '' };
  });

  if (!parsed.nodes.length) {
    return { nodes: [], arrows: [], regions, errors: parsed.errors, count: regions.length };
  }

  // Nodes with explicit coordinates (figures, or a node with @x,y) are placed
  // literally and bypass dagre; the rest are laid out hierarchically.
  const isPlaced = (n) => !!n.shape || (n.x != null && n.y != null);
  const flow = parsed.nodes.filter((n) => !isPlaced(n));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const sizes = {};
  for (const n of flow) {
    const s = estimateSize(n);
    sizes[n.id] = s;
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of parsed.edges) {
    if (sizes[e.from] && sizes[e.to]) g.setEdge(e.from, e.to);
    // n-ary operator members: connect so they cluster in the layout.
    for (const p of (e.participants || [])) {
      if (sizes[e.from] && sizes[p]) g.setEdge(e.from, p);
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

  // Resolve a DSL endpoint id to { region: bool, cid } — node or declared region.
  const resolve = (id) => idMap[id] ? { region: false, cid: idMap[id] }
    : regionRef[id] ? { region: true, cid: regionRef[id] } : null;

  // Build Catego arrows.
  const arrows = [];
  for (const e of parsed.edges) {
    const rf = resolve(e.from), rt = resolve(e.to);
    if (!rf || !rt) continue;
    const a = anchorsFor(centre[e.from], centre[e.to]);
    const id = genId('a');
    const arrow = {
      id,
      fromNodeId: rf.region ? null : rf.cid, fromAnchor: a.from,
      toNodeId: rt.region ? null : rt.cid, toAnchor: a.to,
      fromPillArrowId: null, toPillArrowId: null,
      fromRegionId: rf.region ? rf.cid : null, toRegionId: rt.region ? rt.cid : null,
      fromPoint: null, toPoint: null,
      color: '#cf7bf0',
    };
    if (e.kind) arrow.kind = e.kind;
    if (e.label) arrow.label = e.label;
    if (e.weight != null) arrow.probWeight = Math.min(100, e.weight);
    // Operators lock direction; only set an override for non-operator edges.
    if (!e.operator && e.direction && e.direction !== 'forward') arrow.direction = e.direction;
    // n-ary operator participants: extra endpoints folded into the pill.
    // Anchor each toward the pill centre (midpoint of the base from/to).
    const parts = (e.participants || []).filter((p) => idMap[p]);
    if (parts.length) {
      const pill = { x: (centre[e.from].x + centre[e.to].x) / 2, y: (centre[e.from].y + centre[e.to].y) / 2 };
      arrow.participants = parts.map((p) => ({
        nodeId: idMap[p],
        anchor: anchorsFor(centre[p], pill).from,
      }));
    }
    arrows.push(arrow);
  }

  return { nodes, arrows, regions, errors: parsed.errors, count: nodes.length + regions.length };
}
