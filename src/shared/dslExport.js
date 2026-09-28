/**
 * Catego graph → DSL. The inverse of dslImport: takes board state
 * ({ nodes, arrows, regions }) and emits DSL text that parseDsl/buildGraphFromDsl
 * round-trips back into the same graph. This is the channel an external AI reads
 * a region/board through (and the basis for per-region MCP).
 *
 * Board ids (e.g. `n12_abc`) are valid DSL ids ([A-Za-z0-9_]+), so they are
 * reused verbatim — a re-import preserves identity.
 *
 * Known lossiness (grammar has no syntax for these yet):
 *  - arrow anchors are recomputed from positions on re-import, not preserved;
 *  - free-floating arrow endpoints (fromPoint/toPoint) and pill→pill nesting
 *    are skipped (reported in `warnings`);
 *  - node text is single-line (newlines collapsed, embedded " → ').
 */
import { OPERATOR_KINDS } from './argTypes.js';

const DEFAULT_COLOR = '#cf7bf0';
const OPERATOR_SET = new Set(Object.keys(OPERATOR_KINDS));

const asArray = (v) => Array.isArray(v) ? v : Object.values(v || {});
const q = (s) => `"${String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/"/g, "'")}"`;

function nodeLine(n) {
  // Figures (shape) are emitted in function form (explicit pixel geometry).
  if (n.shape) {
    const args = [Math.round(n.x), Math.round(n.y), Math.round(n.width || 0), Math.round(n.height || 0)];
    if (n.color && n.color !== DEFAULT_COLOR) args.push(n.color);
    return `${n.id} = ${n.shape}(${args.join(', ')})`;
  }
  let s = `${n.id} : `;
  if (n.negated) s += '!';
  if (n.kind) s += `${n.kind} `;
  s += q(n.text);
  if (n.status) s += ` #${n.status}`;
  if (n.probability != null) s += ` %${n.probability}`;
  // Custom width only — height re-measures from text on import.
  if (n.width && n.width !== 220) s += ` (${Math.round(n.width)}x${Math.round(n.height || 60)})`;
  if (n.x != null && n.y != null) s += ` @${Math.round(n.x)},${Math.round(n.y)}`;
  if (n.color && n.color !== DEFAULT_COLOR) s += ` @${n.color}`;
  return s;
}

function regionLine(r) {
  const args = [Math.round(r.x), Math.round(r.y), Math.round(r.x + r.w), Math.round(r.y + r.h)];
  if (r.color && r.color !== DEFAULT_COLOR) args.push(r.color);
  if (r.locked) args.push('locked');
  if (r.noFill) args.push('nofill');
  if (r.label && r.label.trim()) args.push(q(r.label));
  return `${r.id} = region(${args.join(', ')})`;
}

// Endpoint → referenced object id, or a reason it can't be expressed.
function endpointRef(arrow, end) {
  const nodeId = end === 'from' ? arrow.fromNodeId : arrow.toNodeId;
  const regionId = end === 'from' ? arrow.fromRegionId : arrow.toRegionId;
  const pillId = end === 'from' ? arrow.fromPillArrowId : arrow.toPillArrowId;
  const point = end === 'from' ? arrow.fromPoint : arrow.toPoint;
  if (nodeId) return { id: nodeId };
  if (regionId) return { id: regionId };
  if (pillId) return { id: pillId }; // reference the operator pill by its id
  if (point) return { skip: 'free endpoint' };
  return { skip: 'dangling endpoint' };
}

function arrowLine(a, warnings) {
  const f = endpointRef(a, 'from'), t = endpointRef(a, 'to');
  if (f.skip || t.skip) { warnings.push(`arrow ${a.id}: ${f.skip || t.skip} not representable — skipped`); return null; }

  // Operators (and/or/xor/consequently/equivalently/identical) → function form.
  const kind = a.kind === 'consequently' ? 'implies' : a.kind; // legacy rename
  if (kind && OPERATOR_SET.has(kind)) {
    const refs = [f.id, t.id, ...(a.participants || []).map((p) => p.nodeId).filter(Boolean)];
    return `${a.id} = ${kind}(${refs.join(', ')})`;
  }

  // Relations → arrow form. Reverse is normalised to a forward arrow (swap ends).
  const dir = a.direction || (a.bidirectional ? 'both' : 'forward');
  let from = f.id, to = t.id, op = '->';
  if (dir === 'both') op = '<->';
  else if (dir === 'none') op = '--';
  else if (dir === 'reverse') { from = t.id; to = f.id; }
  let s = `${from} ${op} ${to}`;
  if (kind) {
    s += ` : ${kind}`;
    if (a.probWeight != null) s += ` ${a.probWeight}`;
  }
  if (a.label && a.label.trim()) s += ` ${q(a.label)}`;
  return s;
}

/**
 * @param state { nodes, arrows, regions } — maps or arrays of board objects.
 * @returns { text, warnings }
 */
export function serializeToDsl(state = {}) {
  const nodes = asArray(state.nodes);
  const arrows = asArray(state.arrows);
  const regions = asArray(state.regions);
  const warnings = [];

  const plainNodes = nodes.filter((n) => !n.shape);
  const figures = nodes.filter((n) => n.shape);

  const sections = [];
  if (plainNodes.length) sections.push(plainNodes.map(nodeLine).join('\n'));
  if (figures.length) sections.push(figures.map(nodeLine).join('\n'));
  if (regions.length) sections.push(regions.map(regionLine).join('\n'));
  const edgeLines = arrows.map((a) => arrowLine(a, warnings)).filter(Boolean);
  if (edgeLines.length) sections.push(edgeLines.join('\n'));

  return { text: sections.join('\n\n'), warnings };
}
