/**
 * .catego file format = DSL (source of truth for logic; AI reads only this)
 * + a JSON "extras" block (freehand strokes, note links, and other visual data
 * the DSL grammar can't express). The two are separated by a sentinel line.
 *
 * The DSL parser/serializer are reused verbatim from the web app so the
 * language stays identical across web, server (MCP), and this plugin.
 */
// @ts-ignore — pure ESM logic, no DOM/network/dagre deps
import { serializeToDsl } from './shared/dslExport.js';
// @ts-ignore
import { parseDsl } from './shared/dsl.js';

export interface CategoBoard {
  nodes: Record<string, any>;
  arrows: Record<string, any>;
  regions: Record<string, any>;
  strokes: any[];
  /** nodeId -> vault path of the note this node is backed by. */
  notes: Record<string, string>;
}

const EXTRAS_SENTINEL = '%%catego:extras';
const DEFAULT_COLOR = '#cf7bf0';

let idCounter = 0;
function genId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${idCounter}_${Date.now().toString(36)}`;
}

export function emptyBoard(): CategoBoard {
  return { nodes: {}, arrows: {}, regions: {}, strokes: [], notes: {} };
}

// --- serialize -----------------------------------------------------------

export function serializeBoard(board: CategoBoard): string {
  // DSL is the human/AI-readable projection; the JSON `full` snapshot below it is
  // the lossless source of truth (holds everything the DSL can't express — text
  // nodes, arrow color/curve/dash, pill endpoints, fonts, strokes, …).
  const dsl = serializeToDsl({
    nodes: board.nodes,
    arrows: board.arrows,
    regions: board.regions,
  }).text;
  const extras = {
    version: 2,
    notes: board.notes || {},
    full: {
      nodes: board.nodes || {},
      arrows: board.arrows || {},
      regions: board.regions || {},
      strokes: board.strokes || [],
    },
  };
  return `${dsl}\n\n${EXTRAS_SENTINEL}\n${JSON.stringify(extras)}\n`;
}

// --- parse ---------------------------------------------------------------

function anchorsFor(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

function toNode(n: any): any {
  const isFig = !!n.shape;
  const node: any = {
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
    width: n.w || (isFig ? 140 : 220),
    height: n.h || (isFig ? 140 : 60),
    text: n.text || '',
    color: n.color || DEFAULT_COLOR,
  };
  if (n.kind) node.kind = n.kind;
  if (n.status) node.status = n.status;
  if (n.negated) node.negated = true;
  if (n.probability != null) node.probability = n.probability;
  if (n.shape) node.shape = n.shape;
  return node;
}

function toRegion(r: any): any {
  return { id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, color: r.color || DEFAULT_COLOR, locked: !!r.locked, label: r.label || '' };
}

export function parseBoard(text: string): CategoBoard {
  const idx = text.indexOf(EXTRAS_SENTINEL);
  const dslText = idx >= 0 ? text.slice(0, idx) : text;
  let extras: any = { notes: {}, strokes: [] };
  if (idx >= 0) {
    const json = text.slice(idx + EXTRAS_SENTINEL.length).trim();
    try { extras = { ...extras, ...JSON.parse(json) }; } catch { /* keep defaults */ }
  }

  // Lossless path: a full snapshot round-trips the board exactly. The DSL is
  // only parsed for files that don't have one (AI-authored / hand-written).
  if (extras.full && extras.full.nodes) {
    return {
      nodes: extras.full.nodes || {},
      arrows: extras.full.arrows || {},
      regions: extras.full.regions || {},
      strokes: extras.full.strokes || [],
      notes: extras.notes || {},
    };
  }

  const parsed = parseDsl(dslText);
  const regionIds = new Set<string>(parsed.regions.map((r: any) => r.id));

  const nodes: Record<string, any> = {};
  for (const n of parsed.nodes) nodes[n.id] = toNode(n);
  const regions: Record<string, any> = {};
  for (const r of parsed.regions) regions[r.id] = toRegion(r);

  const centre: Record<string, { x: number; y: number }> = {};
  for (const id in nodes) centre[id] = { x: nodes[id].x + nodes[id].width / 2, y: nodes[id].y + nodes[id].height / 2 };
  for (const id in regions) centre[id] = { x: regions[id].x + regions[id].w / 2, y: regions[id].y + regions[id].h / 2 };

  const arrows: Record<string, any> = {};
  for (const e of parsed.edges) {
    if (!centre[e.from] || !centre[e.to]) continue;
    const fromR = regionIds.has(e.from), toR = regionIds.has(e.to);
    const a = anchorsFor(centre[e.from], centre[e.to]);
    const id = e.id || genId('a');
    const arrow: any = {
      id,
      fromNodeId: fromR ? null : e.from, fromAnchor: a.from,
      toNodeId: toR ? null : e.to, toAnchor: a.to,
      fromRegionId: fromR ? e.from : null, toRegionId: toR ? e.to : null,
      fromPillArrowId: null, toPillArrowId: null, fromPoint: null, toPoint: null,
      color: DEFAULT_COLOR,
    };
    if (e.kind) arrow.kind = e.kind;
    if (e.label) arrow.label = e.label;
    if (e.weight != null) arrow.probWeight = e.weight;
    if (!e.operator && e.direction && e.direction !== 'forward') arrow.direction = e.direction;
    const parts = (e.participants || []).filter((p: string) => centre[p]);
    if (parts.length) arrow.participants = parts.map((p: string) => ({ nodeId: p, anchor: 'top' }));
    arrows[id] = arrow;
  }

  return { nodes, arrows, regions, strokes: extras.strokes || [], notes: extras.notes || {} };
}

// --- note → node ---------------------------------------------------------

/** Add a node backed by a vault note. Displays the title; path lives in extras. */
export function addNoteNode(board: CategoBoard, path: string, title: string, x: number, y: number): string {
  const id = genId('n');
  board.nodes[id] = { id, x, y, width: 220, height: 60, text: title, color: DEFAULT_COLOR };
  board.notes[id] = path;
  return id;
}
