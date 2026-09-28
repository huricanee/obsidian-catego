/**
 * Argument-mapping types for nodes and edges.
 *
 * `node.kind` and `arrow.kind` are OPTIONAL — when undefined, the element
 * renders in the original "untyped whiteboard" style.
 *
 * Node kinds (claim roles): thesis / premise / conclusion / counterexample /
 * objection / response. Each gets a tinted background, accent border, and
 * uppercase label above the node.
 *
 * Arrow kinds split into two render flavours, both sit in the unified
 * "Arrow" group in the toolbar:
 *   - "relation" kinds (supports / contradicts / refines / example /
 *     generalizes / counter-example of / presupposes / identical) —
 *     rendered with a colored midpoint circle containing a small glyph.
 *   - "operator" kinds (and / or / consequently / equivalently) — logical
 *     connectives. Rendered with a colored midpoint pill containing a
 *     symbol (∧ / ∨ / ⇒ / ⇔). AND/OR have no arrowheads, consequently
 *     has one arrowhead at the destination, equivalently has arrowheads
 *     at both ends.
 */

// ---- Node kinds (claim roles) ------------------------------------------
// `counterexample` removed — the role is expressed by the
// `counter-example of` arrow (RELATION_KINDS.counterExample), so a dedicated
// node kind would be redundant.
export const NODE_KINDS = {
  thesis:     { label: 'Thesis',     accent: '#5b8cff', bg: '#171f33' },
  premise:    { label: 'Premise',    accent: '#ff8a1f', bg: '#2a1a0e' },
  assumption: { label: 'Assumption', accent: '#f783ac', bg: '#2a1520' },
  belief:     { label: 'Belief',     accent: '#ffdd33', bg: '#2a2410' },
  fact:       { label: 'Fact',       accent: '#6fb88c', bg: '#15241a' },
  conclusion: { label: 'Conclusion', accent: '#b07cff', bg: '#1f1830' },
  objection:  { label: 'Objection',  accent: '#ff6b6b', bg: '#2a1717' },
  response:   { label: 'Response',   accent: '#4ec9d4', bg: '#13252a' },
  definition: { label: 'Definition', accent: '#9ab3c9', bg: '#1a2128' },
  axiom:      { label: 'Axiom',      accent: '#ffffff', bg: '#26262b' },
  postulate:  { label: 'Postulate',  accent: '#9be0b0', bg: '#16241c' },
  question:   { label: 'Question',   accent: '#e09bd9', bg: '#2a1a28' },
  source:     { label: 'Source',     accent: '#6fa8d0', bg: '#13212c' },
  scope:      { label: 'Scope',      accent: '#9ab06a', bg: '#1b2415' },
};

export const NODE_KIND_ORDER = [
  'thesis', 'premise', 'assumption', 'belief', 'fact', 'conclusion',
  'objection', 'response', 'definition', 'axiom', 'postulate', 'question',
  'source', 'scope',
];

// ---- Node text fonts ----------------------------------------------------
// `node.fontFamily` key → CSS font stack. `node.fontSize` is a px number.
export const FONT_FAMILIES = {
  sans:  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono:  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
export const FONT_FAMILY_ORDER = ['sans', 'serif', 'mono'];
export const FONT_FAMILY_LABEL = { sans: 'Sans', serif: 'Serif', mono: 'Mono' };
export const DEFAULT_FONT_SIZE = 14;

// ---- Node status (epistemic state) — shown as a pill BELOW the node -------
export const NODE_STATUSES = {
  accepted:   { label: 'accepted',   color: '#52c98b' }, // green
  challenged: { label: 'challenged', color: '#ff6b6b' }, // red
  disputed:   { label: 'disputed',   color: '#5b8cff' }, // blue
  unsolvable: { label: 'unsolvable', color: '#ffa14a' }, // orange
};
// Settings layout: None (full width), then a 2×2 grid.
export const NODE_STATUS_ROWS = [
  ['accepted', 'challenged'],
  ['disputed', 'unsolvable'],
];

// ---- Edge "relation" kinds ---------------------------------------------
// `render: 'glyph'` — colored midpoint circle with a small icon.
// `arrows: 'forward'` — single arrowhead at destination.
// `rotateWithFlow: true` → the midpoint glyph rotates with the bezier
// tangent at the midpoint, so a directional/oriented symbol stays
// aligned with the curve.
export const RELATION_KINDS = {
  supports:       { label: 'supports',                 stroke: '#cf7bf0', glyph: 'plus'       },
  contradicts:    { label: 'contradicts',              stroke: '#ff6b6b', glyph: 'cross'      },
  refines:        { label: 'refines',                  stroke: '#c89aff', glyph: 'narrow'     },
  example:        { label: 'is example of',            stroke: '#52c98b', glyph: 'dots'       },
  generalizes:    { label: 'generalizes',              stroke: '#9ad9ff', glyph: 'tri-up'     },
  counterExample: { label: 'counter-example of',       stroke: '#ffa14a', glyph: 'circ-slash' },
  presupposes:    { label: 'presupposes',              stroke: '#9aa3b8', glyph: 'turnstile',  rotateWithFlow: true },
  necessaryFor:   { label: 'necessary condition for',  stroke: '#d0b057', glyph: 'half-arrow', rotateWithFlow: true },
  sufficientFor:  { label: 'sufficient condition for', stroke: '#e0a24a', glyph: 'sufficient' },
  analogy:        { label: 'analogous to',             stroke: '#d98cd9', glyph: 'approx'     },
  identical:      { label: 'identical',                stroke: '#4ec9d4', glyph: 'tri-bar',    rotateWithFlow: true },
  // Probability shifters. The midpoint glyph is a `%` whose slash IS the
  // arrow — fixed orientation (down-left vs up-right), independent of the
  // bezier tangent, so the direction reads as "down = decrease" /
  // "up = increase" regardless of where the source/target sit on canvas.
  // `weighted: true` → the pill is widened and carries an editable integer
  // (1–100) parameter on the right, rating how strongly the influence acts.
  probDecreases:  { label: 'decreases the probability', stroke: '#ff8aa1', glyph: 'percent-down', weighted: true },
  probIncreases:  { label: 'increases the probability', stroke: '#8be0a8', glyph: 'percent-up',   weighted: true },
};

export const RELATION_KIND_ORDER = [
  'supports', 'contradicts', 'refines', 'example',
  'generalizes', 'counterExample', 'presupposes', 'necessaryFor', 'sufficientFor',
  'analogy', 'identical', 'probDecreases', 'probIncreases',
];

// ---- Edge "operator" kinds (logical connectives) -----------------------
// `render: 'text'` — colored midpoint pill with a symbol.
// `arrows`: 'none' | 'forward' | 'both' — which ends get arrowheads.
const OP_STROKE = '#ffb54a';

// `text` is shown on the toolbar chip. `symbol` is shown in the canvas pill.
// `implies` (⇒) is the truth-functional conditional — a connective, like ∧ ∨ ⊕ ⇔.
// `therefore` (∴) is the illative: it marks a step of inference ("A, hence B"),
// which is a different level (meta) from the conditional. See tasks/roadmap.
export const OPERATOR_KINDS = {
  and:          { label: 'AND',          text: 'AND',          symbol: '∧', stroke: OP_STROKE, arrows: 'none'    },
  or:           { label: 'OR',           text: 'OR',           symbol: '∨', stroke: OP_STROKE, arrows: 'none'    },
  xor:          { label: 'XOR',          text: 'XOR',          symbol: '⊕', stroke: OP_STROKE, arrows: 'none'    },
  implies:      { label: 'Implies',      text: 'Implies',      symbol: '⇒', stroke: OP_STROKE, arrows: 'forward', rotateWithFlow: true },
  therefore:    { label: 'Therefore',    text: 'Therefore',    symbol: '→', stroke: OP_STROKE, arrows: 'forward', rotateWithFlow: true },
  equivalently: { label: 'Equivalently', text: 'Equivalently', symbol: '⇔', stroke: OP_STROKE, arrows: 'both',    rotateWithFlow: true },
  // Everyday-reasoning connectives (the panel's "Reality" group, with
  // therefore): not truth-functional, they mark how real thinking moves.
  because:      { label: 'Because',      text: 'Because',      symbol: '←', stroke: OP_STROKE, arrows: 'forward', rotateWithFlow: true },
  // `icon` — SVG path (stroked, centred on 0,0, ~20px) drawn in the pill
  // instead of `symbol`. But's ☝ stays upright whatever the arrow direction.
  but:          { label: 'But',          text: 'But',          symbol: '☝', stroke: OP_STROKE, arrows: 'forward',
                  icon: 'M -2 1 V -8 a 2 2 0 0 1 4 0 V 1 M 2 -0.5 a 1.8 1.8 0 0 1 3.4 0.6 V 1.5 M 5.4 0.6 a 1.7 1.7 0 0 1 3.1 0.9 V 4 a 6 6 0 0 1 -6 6 H 0 a 6 6 0 0 1 -5.4 -3.4 L -7.6 2.4 a 1.7 1.7 0 0 1 2.9 -1.8 L -2 3.6' },
  inOrderTo:    { label: 'In order to',  text: 'In order to',  symbol: '⤳', stroke: OP_STROKE, arrows: 'forward', rotateWithFlow: true },
  // Legacy: boards saved before the rename store kind='consequently'. Kept so
  // they keep rendering; not listed in the order below, so it's absent from the
  // UI and never assigned to new arrows.
  consequently: { label: 'Implies',      text: 'Implies',      symbol: '⇒', stroke: OP_STROKE, arrows: 'forward', rotateWithFlow: true, legacy: true },
};

export const OPERATOR_KIND_ORDER = ['and', 'or', 'xor', 'implies', 'therefore', 'equivalently', 'because', 'but', 'inOrderTo'];

// Operator arrows have a semantically-FIXED arrowhead direction (AND/OR/XOR
// carry no direction, Consequently is one-way, Equivalently is two-way), so
// the per-arrow direction control is locked for them.
export function isDirectionLocked(kind) {
  const def = kind ? EDGE_KINDS[kind] : null;
  return !!(def && def.render === 'text');
}

// ---- Unified EDGE_KINDS map (operators + relations) --------------------
// Renderer dispatches on `render` field. `arrows` defaults to 'forward'
// for relations.
export const EDGE_KINDS = {
  ...Object.fromEntries(Object.entries(OPERATOR_KINDS).map(([k, v]) => [k, { ...v, render: 'text' }])),
  ...Object.fromEntries(Object.entries(RELATION_KINDS).map(([k, v]) => [k, { ...v, arrows: 'forward', render: 'glyph' }])),
};

// Order shown in the toolbar's Arrow row: operators first, then relations.
export const EDGE_KIND_ORDER = [...OPERATOR_KIND_ORDER, ...RELATION_KIND_ORDER];
