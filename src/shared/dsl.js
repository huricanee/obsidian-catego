/**
 * Catego DSL — a small Mermaid-like text language that transcribes into a
 * Catego graph. Phase-2 v1: nodes + binary typed edges (regions / figures /
 * n-ary operators are planned follow-ups — see tasks/dsl-import.md).
 *
 * Grammar (one statement per line; blank lines and `#`/`//` comment lines
 * are ignored):
 *
 *   NODE   id : [!][kind] "text" [#status] [%prob] [(WxH)] [@x,y] [@#rrggbb]
 *          id : "text"                      (untyped)
 *   EDGE   from OP to [: kind [weight]] ["label"]
 *   OPER   id = op(a, b [, c, ...])         (n-ary logical connective)
 *   REGION id = region(x1, y1, x2, y2 [, #color] [, locked] [, nofill] [, "name"])
 *   FIGURE id = shape(x, y, w, h [, #color])   shape = rect|square|circle|ellipse|triangle
 *
 *   OP =  ->  forward   |  <-  reverse  |  <->  both  |  --  no arrows
 *         =>  implies (sugar)            |  <=>  equivalently (sugar)
 *   op = and | or | xor | implies | therefore | equivalently | identical
 *   !       leading bang on a node = negated (¬)
 *   %NN     node probability pill (0–100)
 *   @x,y    explicit node position (pixels); without it dagre lays the node out
 *   weight  number after a prob± edge kind = probability weight (0–100)
 *
 * An edge/operator endpoint that names a declared region attaches to that
 * region; otherwise nodes referenced but never declared are auto-created.
 */
import { NODE_KINDS, EDGE_KINDS, NODE_STATUSES } from './argTypes.js';

// ---- alias maps ---------------------------------------------------------
const NODE_KIND_ALIAS = (() => {
  const m = {};
  for (const k of Object.keys(NODE_KINDS)) m[k] = k;
  Object.assign(m, { concl: 'conclusion', prem: 'premise', def: 'definition', hyp: 'assumption' });
  return m;
})();

const EDGE_KIND_ALIAS = (() => {
  const m = {};
  for (const k of Object.keys(EDGE_KINDS)) m[k.toLowerCase()] = k;
  Object.assign(m, {
    'counter-example': 'counterExample', counterexample: 'counterExample', counter: 'counterExample',
    necessary: 'necessaryFor', sufficient: 'sufficientFor',
    decreases: 'probDecreases', increases: 'probIncreases',
    'is-example-of': 'example', eg: 'example',
  });
  return m;
})();

const STATUS_ALIAS = (() => {
  const m = {};
  for (const k of Object.keys(NODE_STATUSES)) m[k] = k;
  return m;
})();

// Operator (n-ary connective) function names → EDGE_KINDS keys.
const OPERATOR_ALIAS = {
  and: 'and', or: 'or', xor: 'xor',
  implies: 'implies', therefore: 'therefore', equivalently: 'equivalently',
  identical: 'identical',
  because: 'because', but: 'but', inOrderTo: 'inOrderTo', inorderto: 'inOrderTo',
  consequently: 'implies', // legacy name
};

// Figure function names (a figure is a node with a `shape` field).
const SHAPE_NAMES = new Set(['rect', 'square', 'circle', 'ellipse', 'triangle']);

const ID = '[A-Za-z0-9_]+';
// `id = fn( args )` — operator or region assignment.
const FUNC_RE = new RegExp(`^(${ID})\\s*=\\s*([A-Za-z][A-Za-z0-9_]*)\\s*\\((.*)\\)\\s*$`);

// Split a function arg list on top-level commas (respecting "quoted" strings).
function splitArgs(s) {
  const str = s.trim();
  if (!str) return [];
  const out = [];
  let cur = '', q = false;
  for (const ch of str) {
    if (ch === '"') { q = !q; cur += ch; }
    else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const unquote = (s) => (s && s[0] === '"' && s[s.length - 1] === '"') ? s.slice(1, -1) : s;
const NODE_RE = new RegExp(
  `^(${ID})\\s*:\\s*(!)?\\s*(?:([A-Za-z][A-Za-z0-9_-]*)\\s+)?"([^"]*)"` +
  `\\s*(?:#([A-Za-z]+))?` +
  `\\s*(?:%(\\d+))?` +
  `\\s*(?:\\((\\d+)\\s*[xX*]\\s*(\\d+)\\))?` +
  `\\s*(?:@(-?\\d+)\\s*,\\s*(-?\\d+))?` +
  `\\s*(?:@(#[0-9a-fA-F]{3,8}))?\\s*$`
);
const EDGE_RE = new RegExp(
  `^(${ID})\\s*(->|<->|<=>|<-|=>|--)\\s*(${ID})` +
  `\\s*(?::\\s*([A-Za-z][A-Za-z0-9_-]*)(?:\\s+(\\d+))?)?` +
  `\\s*(?:"([^"]*)")?\\s*$`
);

function edgeFromOp(op) {
  // Returns { swap, direction, kind } for the operator token.
  switch (op) {
    case '->':  return { swap: false, direction: 'forward' };
    case '<-':  return { swap: true,  direction: 'forward' };
    case '<->': return { swap: false, direction: 'both' };
    case '--':  return { swap: false, direction: 'none' };
    case '=>':  return { swap: false, direction: 'forward', kind: 'implies' };
    case '<=>': return { swap: false, direction: 'both',    kind: 'equivalently' };
    default:    return { swap: false, direction: 'forward' };
  }
}

export function parseDsl(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = new Map();   // id -> node object (declaration order preserved)
  const edges = [];
  const regions = [];
  const errors = [];

  const ensureNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind: null, text: id, status: null, color: null, w: null, h: null, x: null, y: null, shape: null, negated: false, probability: null, declared: false });
    return nodes.get(id);
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    // id = fn(args) — operator or region.
    const fm = line.match(FUNC_RE);
    if (fm) {
      const [, id, fnRaw, argStr] = fm;
      const fn = fnRaw.toLowerCase();
      const args = splitArgs(argStr);

      if (fn === 'region') {
        if (args.length < 4) { errors.push(`line ${i + 1}: region needs at least x1,y1,x2,y2`); return; }
        const [x1, y1, x2, y2] = args.slice(0, 4).map(Number);
        if ([x1, y1, x2, y2].some(Number.isNaN)) { errors.push(`line ${i + 1}: region coords must be numbers`); return; }
        const region = { id, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), color: null, locked: false, noFill: false, label: '' };
        for (const extra of args.slice(4)) {
          if (/^#[0-9a-fA-F]{3,8}$/.test(extra)) region.color = extra;
          else if (/^"/.test(extra)) region.label = unquote(extra);
          else if (/^(locked|true)$/i.test(extra)) region.locked = true;
          else if (/^nofill$/i.test(extra)) region.noFill = true;
          else if (/^(unlocked|false)$/i.test(extra)) region.locked = false;
          else errors.push(`line ${i + 1}: region: unrecognized arg "${extra}"`);
        }
        regions.push(region);
        return;
      }

      if (SHAPE_NAMES.has(fn)) {
        if (args.length < 4) { errors.push(`line ${i + 1}: ${fn}() needs x, y, w, h`); return; }
        const [x, y, w, h] = args.slice(0, 4).map(Number);
        if ([x, y, w, h].some(Number.isNaN)) { errors.push(`line ${i + 1}: ${fn}: x,y,w,h must be numbers`); return; }
        const node = ensureNode(id);
        node.declared = true;
        node.shape = fn;
        node.text = '';
        node.x = x; node.y = y; node.w = w; node.h = h; // figure sizes are pixels
        const color = args.slice(4).find((a) => /^#[0-9a-fA-F]{3,8}$/.test(a));
        if (color) node.color = color;
        return;
      }

      const kind = OPERATOR_ALIAS[fn];
      if (kind) {
        if (args.length < 2) { errors.push(`line ${i + 1}: ${fn}() needs at least 2 nodes`); return; }
        const ids = args.map(unquote);
        ids.forEach(ensureNode);
        const [from, to, ...rest] = ids;
        edges.push({ id, from, to, kind, label: null, direction: null, participants: rest, operator: true });
        return;
      }

      errors.push(`line ${i + 1}: unknown function "${fnRaw}"`);
      return;
    }

    const em = line.match(EDGE_RE);
    if (em) {
      const [, a, op, b, kindRaw, weightRaw, label] = em;
      const o = edgeFromOp(op);
      let kind = o.kind || null;
      if (kindRaw) {
        const mapped = EDGE_KIND_ALIAS[kindRaw.toLowerCase()];
        if (!mapped) errors.push(`line ${i + 1}: unknown arrow type "${kindRaw}"`);
        else kind = mapped;
      }
      ensureNode(a);
      ensureNode(b);
      const from = o.swap ? b : a;
      const to = o.swap ? a : b;
      const weight = weightRaw != null ? parseInt(weightRaw, 10) : null;
      edges.push({ from, to, kind, label: label || null, direction: o.direction, weight });
      return;
    }

    const nm = line.match(NODE_RE);
    if (nm) {
      const [, id, neg, kindRaw, text, statusRaw, prob, w, h, posX, posY, color] = nm;
      const node = ensureNode(id);
      node.declared = true;
      node.text = text;
      node.negated = !!neg;
      if (prob != null) node.probability = Math.min(100, parseInt(prob, 10));
      if (posX != null && posY != null) { node.x = parseInt(posX, 10); node.y = parseInt(posY, 10); }
      if (kindRaw) {
        const mapped = NODE_KIND_ALIAS[kindRaw.toLowerCase()];
        if (!mapped) errors.push(`line ${i + 1}: unknown node type "${kindRaw}" (kept untyped)`);
        else node.kind = mapped;
      }
      if (statusRaw) {
        const mapped = STATUS_ALIAS[statusRaw.toLowerCase()];
        if (!mapped) errors.push(`line ${i + 1}: unknown status "${statusRaw}"`);
        else node.status = mapped;
      }
      if (w && h) { node.w = parseInt(w, 10); node.h = parseInt(h, 10); }
      if (color) node.color = color;
      return;
    }

    errors.push(`line ${i + 1}: couldn't parse "${line}"`);
  });

  // Endpoints that name a declared region were auto-created as phantom nodes —
  // drop them so they resolve to the region instead.
  const regionIds = new Set(regions.map((r) => r.id));
  for (const [id, n] of nodes) {
    if (!n.declared && regionIds.has(id)) nodes.delete(id);
  }

  return { nodes: Array.from(nodes.values()), edges, regions, errors };
}
