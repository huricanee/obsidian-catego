/**
 * State-driven SVG exporter for Catego boards.
 *
 * Builds an SVG string directly from `state.nodes` / `state.arrows`
 * (no DOM cloning, no html-to-image). The result is rasterised via
 * the browser's Image loader onto a canvas, which feeds JPEG/PDF
 * export in App.jsx.
 *
 * Trade-offs vs. the live canvas:
 *   - Long node text is rendered line-by-line (newlines only); no
 *     word wrapping. Wide text simply clips.
 *   - LaTeX (`$...$`) is rendered as literal source text. Embedding
 *     KaTeX into the exported SVG was rejected as out-of-scope.
 *   - Freehand strokes, regions, toolbar, cursors, anchor dots,
 *     resize handles and selection halos are intentionally skipped.
 */

import {
  getAnchorPos,
  bezierPath,
  elbowPath,
  arrowheadPoints,
  getPillBounds,
  resolveEndpoint,
} from './Canvas.jsx';
import { NODE_KINDS, EDGE_KINDS, NODE_STATUSES, FONT_FAMILIES } from './argTypes.js';

const PADDING = 40;
const DEFAULT_W = 220;
const DEFAULT_H = 60;
// Horizontal padding inside a node rect (matches .wb-node CSS `padding: 12px 16px`).
const NODE_TEXT_PADDING_X = 16;

// Single shared offscreen canvas for word-wrap measurement. measureText() is
// cheap once the context's font is set; we re-use the same context across
// nodes so we don't churn DOM elements during a large export.
let _measureCtx = null;
function getMeasureCtx() {
  if (_measureCtx) return _measureCtx;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  _measureCtx = c.getContext('2d');
  return _measureCtx;
}

/* Greedy word wrap: split `line` into rows that each fit inside `maxWidth`
   when rendered with `font`. Whitespace-only breaks (no character-level
   fallback); a single word wider than maxWidth overflows. */
function wrapLine(line, maxWidth, font) {
  const ctx = getMeasureCtx();
  if (!ctx || !line) return [line || ''];
  ctx.font = font;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const rows = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = current + ' ' + words[i];
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      rows.push(current);
      current = words[i];
    }
  }
  rows.push(current);
  return rows;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nodeDims(n) {
  return {
    w: n.width || DEFAULT_W,
    h: n.height || DEFAULT_H,
  };
}

/* ----------------------------------------------------------------
   Bounding box across all rendered geometry.
   ---------------------------------------------------------------- */
function computeBounds(state) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const n of Object.values(state.nodes || {})) {
    const { w, h } = nodeDims(n);
    acc(n.x, n.y - 18); // kind label sits ~18px above
    acc(n.x + w, n.y + h);
  }

  for (const r of Object.values(state.regions || {})) {
    acc(r.x, r.y - 24); // label sits ~24px above
    acc(r.x + r.w, r.y + r.h);
  }

  for (const arrow of Object.values(state.arrows || {})) {
    const from = resolveEndpoint(arrow, 'from', state.nodes, state.arrows, {}, EDGE_KINDS, state.regions || {});
    const to   = resolveEndpoint(arrow, 'to',   state.nodes, state.arrows, {}, EDGE_KINDS, state.regions || {});
    if (!from || !to) continue;
    acc(from.x, from.y);
    acc(to.x, to.y);
    const { midX, midY } = bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, arrow.fromCtrl, arrow.toCtrl);
    acc(midX - 15, midY - 15);
    acc(midX + 15, midY + 15);
  }

  if (minX === Infinity) {
    // Empty board — show a small framed area.
    return { x: 0, y: 0, w: 800, h: 600 };
  }
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    w: (maxX - minX) + PADDING * 2,
    h: (maxY - minY) + PADDING * 2,
  };
}

/* ----------------------------------------------------------------
   Theme palette — mirrors the on-screen scheme with a light-theme
   fallback that swaps backgrounds / default text.
   ---------------------------------------------------------------- */
function getTheme(light) {
  if (light) {
    return {
      bg:          '#ffffff',
      nodeBg:      '#ffffff',
      nodeBorder:  '#5b6b8c',
      text:        '#1a1a20',
      defaultArrow:'#3a4a78',
      pillBg:      '#ffffff',
      negBadgeBg:  '#cc3030',
      negBadgeTxt: '#ffffff',
      probBg:      '#1a1a20',
      probTxt:     '#ffffff',
    };
  }
  return {
    bg:          '#000000',
    nodeBg:      '#111118',
    nodeBorder:  '#cf7bf0',
    text:        '#e0e0e8',
    defaultArrow:'#cf7bf0',
    pillBg:      '#0e0e10',
    negBadgeBg:  '#cc3030',
    negBadgeTxt: '#ffffff',
    probBg:      '#222230',
    probTxt:     '#e0e0e8',
  };
}

/* ----------------------------------------------------------------
   Glyph SVG for relation kinds. Mirrors Canvas.jsx exactly.
   ---------------------------------------------------------------- */
function renderGlyph(glyph, color) {
  switch (glyph) {
    case 'plus':
      return (
        `<line x1="-7.5" y1="0" x2="7.5" y2="0" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>` +
        `<line x1="0" y1="-7.5" x2="0" y2="7.5" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`
      );
    case 'cross':
      return (
        `<line x1="-6" y1="-6" x2="6" y2="6" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>` +
        `<line x1="-6" y1="6" x2="6" y2="-6" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`
      );
    case 'narrow':
      return (
        `<polyline points="-7.5,-6 -1.5,0 -7.5,6" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<polyline points="7.5,-6 1.5,0 7.5,6" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    case 'dots':
      return (
        `<circle cx="-6" cy="0" r="2" fill="${color}"/>` +
        `<circle cx="0" cy="0" r="2" fill="${color}"/>` +
        `<circle cx="6" cy="0" r="2" fill="${color}"/>`
      );
    case 'tri-up':
      return `<polygon points="-7.5,6 7.5,6 0,-7.5" fill="${color}"/>`;
    case 'circ-slash':
      return `<line x1="-7.5" y1="7.5" x2="7.5" y2="-7.5" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
    case 'turnstile':
      return (
        `<line x1="-4.5" y1="-7.5" x2="-4.5" y2="7.5" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>` +
        `<line x1="-4.5" y1="0" x2="6" y2="0" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`
      );
    case 'tri-bar':
      return (
        `<line x1="-7.5" y1="-4.5" x2="7.5" y2="-4.5" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>` +
        `<line x1="-7.5" y1="0" x2="7.5" y2="0" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>` +
        `<line x1="-7.5" y1="4.5" x2="7.5" y2="4.5" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`
      );
    case 'half-arrow':
      // ⇀ — "necessary condition for". Half-arrow captures
      // "necessary but not sufficient" — direction without a full head.
      return (
        `<text x="0" y="1" text-anchor="middle" dominant-baseline="middle" ` +
          `fill="${color}" font-family="system-ui, sans-serif" font-size="24" font-weight="700">⇀</text>`
      );
    case 'sufficient':
      // "sufficient condition for" — full arrow made of two necessary-
      // condition harpoon halves: ⇀ and the same glyph mirrored vertically
      // (so the halves match exactly), with a "?" on the left.
      return (
        `<text x="-8" y="1" text-anchor="middle" dominant-baseline="middle" ` +
          `fill="${color}" font-family="system-ui, sans-serif" font-size="13" font-weight="400">?</text>` +
        `<text x="3" y="0" text-anchor="middle" dominant-baseline="middle" ` +
          `fill="${color}" font-family="system-ui, sans-serif" font-size="18" font-weight="700">⇀</text>` +
        `<text x="3" y="0" text-anchor="middle" dominant-baseline="middle" transform="scale(1 -1)" ` +
          `fill="${color}" font-family="system-ui, sans-serif" font-size="18" font-weight="700">⇀</text>`
      );
    case 'approx':
      // ≈ — "analogous to". Two wavy lines = similarity / analogy.
      return (
        `<path d="M -5 -3 q 2.5 -3 5 0 q 2.5 3 5 0" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>` +
        `<path d="M -5 3 q 2.5 -3 5 0 q 2.5 3 5 0" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`
      );
    case 'percent-down':
      return (
        `<circle cx="-4.5" cy="-4.5" r="2.3" fill="none" stroke="${color}" stroke-width="1.8"/>` +
        `<circle cx="4.5" cy="4.5" r="2.3" fill="none" stroke="${color}" stroke-width="1.8"/>` +
        `<line x1="8.25" y1="-8.25" x2="-4.5" y2="4.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round"/>` +
        `<polygon points="-9,9 -3,7.13 -7.13,3" fill="${color}"/>`
      );
    case 'percent-up':
      return (
        `<circle cx="-4.5" cy="-4.5" r="2.3" fill="none" stroke="${color}" stroke-width="1.8"/>` +
        `<circle cx="4.5" cy="4.5" r="2.3" fill="none" stroke="${color}" stroke-width="1.8"/>` +
        `<line x1="-8.25" y1="8.25" x2="4.5" y2="-4.5" stroke="${color}" stroke-width="2.8" stroke-linecap="round"/>` +
        `<polygon points="9,-9 3,-7.13 7.13,-3" fill="${color}"/>`
      );
    default:
      return '';
  }
}

/* ----------------------------------------------------------------
   Per-region SVG — mirrors the on-screen .wb-region styling:
   rounded rect, 8%-opacity fill, 3px colored border, label above.
   ---------------------------------------------------------------- */
function renderRegion(r) {
  const color = r.color || '#cf7bf0';
  const parts = [
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8" ry="8" ` +
      `fill="${r.noFill ? 'none' : color}" fill-opacity="0.08" stroke="${color}" stroke-width="3"/>`,
  ];
  if (r.label && r.label.trim()) {
    parts.push(
      `<text x="${r.x + 4}" y="${r.y - 9}" ` +
        `font-family="system-ui, -apple-system, sans-serif" font-size="13" ` +
        `font-weight="600" fill="${color}">${esc(r.label)}</text>`
    );
  }
  return parts.join('');
}

/* ----------------------------------------------------------------
   Per-node SVG
   ---------------------------------------------------------------- */
function renderNode(n, theme) {
  const { w, h } = nodeDims(n);
  const kindDef = n.kind ? NODE_KINDS[n.kind] : null;
  const parts = [];

  // Kind label above
  if (kindDef) {
    parts.push(
      `<text x="${n.x + 8}" y="${n.y - 6}" ` +
        `font-family="system-ui, -apple-system, sans-serif" font-size="11" ` +
        `font-weight="600" letter-spacing="0.5" fill="${kindDef.accent}">` +
        `${esc(kindDef.label.toUpperCase())}</text>`
    );
  }

  if (n.shape) {
    // Figure: rectangle / square / circle / triangle.
    const color = n.color || theme.nodeBorder;
    const fill = `${color}1f`;
    if (n.shape === 'rect' || n.shape === 'square') {
      parts.push(`<rect x="${n.x}" y="${n.y}" width="${w}" height="${h}" rx="4" ry="4" fill="${fill}" stroke="${color}" stroke-width="2"/>`);
    } else if (n.shape === 'circle' || n.shape === 'ellipse') {
      parts.push(`<ellipse cx="${n.x + w / 2}" cy="${n.y + h / 2}" rx="${w / 2 - 1}" ry="${h / 2 - 1}" fill="${fill}" stroke="${color}" stroke-width="2"/>`);
    } else if (n.shape === 'triangle') {
      parts.push(`<polygon points="${n.x + w / 2},${n.y + 1} ${n.x + w - 1},${n.y + h - 1} ${n.x + 1},${n.y + h - 1}" fill="${fill}" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
    }
  } else if (n.style !== 'text') {
    const border = kindDef ? kindDef.accent : (n.color || theme.nodeBorder);
    const fill   = kindDef ? kindDef.bg     : theme.nodeBg;
    parts.push(
      `<rect x="${n.x}" y="${n.y}" width="${w}" height="${h}" rx="20" ry="20" ` +
        `fill="${fill}" stroke="${border}" stroke-width="1.5"/>`
    );
  }

  // Text content — first split on explicit `\n`, then word-wrap each
  // resulting line to the node's interior width so the export matches
  // the on-screen layout (the live canvas wraps via CSS `word-break`).
  const raw = (n.text != null ? String(n.text) : '');
  const fontSize = n.fontSize || 14;
  const fontFamily = FONT_FAMILIES[n.fontFamily] || 'system-ui, -apple-system, sans-serif';
  const font = `${fontSize}px ${fontFamily}`;
  const isText = n.style === 'text';
  // text-style nodes have padding 4px 8px and no border; regular nodes 12px 16px.
  const padX = isText ? 8 : NODE_TEXT_PADDING_X;
  const innerW = Math.max(20, w - padX * 2);
  const explicitLines = raw.split(/\r?\n/);
  const wrappedLines = [];
  for (const ln of explicitLines) {
    const rows = wrapLine(ln, innerW, font);
    for (const r of rows) wrappedLines.push(r);
  }
  const lineH = Math.round(fontSize * 1.3);
  const totalH = wrappedLines.length * lineH;
  const padV = 12;
  const startY = (n.valign === 'top'
    ? n.y + padV
    : n.valign === 'bottom'
      ? n.y + h - totalH - padV
      : n.y + h / 2 - totalH / 2) + lineH * 0.75;
  const tspans = wrappedLines.map((ln, i) =>
    `<tspan x="${n.x + w / 2}" y="${startY + i * lineH}">${esc(ln)}</tspan>`
  ).join('');
  // Text nodes colour their text with the node color.
  const textFill = n.style === 'text' ? (n.color || theme.text) : theme.text;
  parts.push(
    `<text font-family="${fontFamily}" font-size="${fontSize}" ` +
      `text-anchor="middle" fill="${textFill}">${tspans}</text>`
  );

  // Status pill below the node, left-aligned, font matched to the kind label.
  if (n.status && NODE_STATUSES[n.status]) {
    const col = NODE_STATUSES[n.status].color;
    const label = NODE_STATUSES[n.status].label.toUpperCase();
    const pw = label.length * 7.5 + 18;
    const px = n.x;
    const py = n.y + h + 6;
    parts.push(
      `<rect x="${px}" y="${py}" width="${pw}" height="19" rx="9.5" ry="9.5" fill="#0e0e10" stroke="${col}" stroke-width="1.5"/>` +
      `<text x="${px + pw / 2}" y="${py + 13.5}" text-anchor="middle" font-family="system-ui, sans-serif" ` +
        `font-size="11" font-weight="600" letter-spacing="0.7" fill="${col}">${esc(label)}</text>`
    );
  }

  // Negation badge (top-right)
  if (n.negated) {
    const cx = n.x + w - 12;
    const cy = n.y + 12;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="12" fill="${theme.negBadgeBg}"/>` +
      `<text x="${cx}" y="${cy + 4}" text-anchor="middle" ` +
        `font-family="system-ui, sans-serif" font-size="14" font-weight="700" ` +
        `fill="${theme.negBadgeTxt}">&#172;</text>`
    );
  }

  // Probability pill (top-right; offset left when negation also present)
  if (n.probability != null) {
    const pillW = 36;
    const pillH = 18;
    const offset = n.negated ? 30 : 4;
    const px = n.x + w - pillW - offset;
    const py = n.y + 4;
    parts.push(
      `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="9" ry="9" ` +
        `fill="${theme.probBg}"/>` +
      `<text x="${px + pillW / 2}" y="${py + pillH / 2 + 4}" text-anchor="middle" ` +
        `font-family="system-ui, sans-serif" font-size="11" font-weight="600" ` +
        `fill="${theme.probTxt}">${esc(n.probability)}%</text>`
    );
  }

  return parts.join('');
}

/* ----------------------------------------------------------------
   Per-arrow SVG
   ---------------------------------------------------------------- */
function renderArrow(arrow, state, theme) {
  const from = resolveEndpoint(arrow, 'from', state.nodes, state.arrows, {}, EDGE_KINDS, state.regions || {});
  const to   = resolveEndpoint(arrow, 'to',   state.nodes, state.arrows, {}, EDGE_KINDS, state.regions || {});
  if (!from || !to) return '';

  const { path, cp1x, cp1y, cp2x, cp2y, midX, midY } = (arrow.line === 'elbow' || arrow.line === 'straight')
    ? elbowPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor)
    : bezierPath(from.x, from.y, from.anchor, to.x, to.y, to.anchor, arrow.fromCtrl, arrow.toCtrl);
  const kindDef = arrow.kind ? EDGE_KINDS[arrow.kind] : null;
  const color = kindDef ? kindDef.stroke : (arrow.color || theme.defaultArrow);
  const strokeWidth = kindDef && kindDef.render === 'glyph' ? 1.8 : 2;
  const dirLocked = kindDef && kindDef.render === 'text';
  const arrowsMode = dirLocked
    ? (kindDef.arrows || 'forward')
    : (arrow.direction || (arrow.bidirectional ? 'both' : (kindDef ? (kindDef.arrows || 'forward') : 'forward')));
  const dashAttr = arrow.dash === 1 ? ' stroke-dasharray="7 5"' : arrow.dash === 2 ? ' stroke-dasharray="14 9"' : '';

  const parts = [];
  // n-ary operator extra participants (∧ / ∨ / identical): draw an
  // additional bezier from each into the host arrow's pill.
  const participants = arrow.participants || [];
  if (participants.length) {
    const b = kindDef ? getPillBounds(arrow, EDGE_KINDS) : null;
    if (b) {
      const sides = [
        { a: 'top',    x: midX,           y: midY - b.halfH },
        { a: 'right',  x: midX + b.halfW, y: midY },
        { a: 'bottom', x: midX,           y: midY + b.halfH },
        { a: 'left',   x: midX - b.halfW, y: midY },
      ];
      for (const p of participants) {
        if (!p || !p.nodeId) continue;
        const pNode = state.nodes[p.nodeId];
        if (!pNode) continue;
        const pPos = getAnchorPos(pNode, p.anchor, {});
        let best = sides[0], bestD = Infinity;
        for (const s of sides) {
          const d = (s.x - pPos.x) ** 2 + (s.y - pPos.y) ** 2;
          if (d < bestD) { bestD = d; best = s; }
        }
        const partial = bezierPath(pPos.x, pPos.y, p.anchor, best.x, best.y, best.a);
        parts.push(
          `<path d="${partial.path}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`
        );
      }
    }
  }
  parts.push(
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"${dashAttr}/>`
  );

  if (arrowsMode === 'forward' || arrowsMode === 'both') {
    parts.push(
      `<polygon points="${arrowheadPoints(to.x, to.y, cp2x, cp2y, 10)}" fill="${color}"/>`
    );
  }
  if (arrowsMode === 'reverse' || arrowsMode === 'both') {
    parts.push(
      `<polygon points="${arrowheadPoints(from.x, from.y, cp1x, cp1y, 10)}" fill="${color}"/>`
    );
  }

  // Midpoint marker — rotate with curve tangent when the kind opts in
  // (consequently / equivalently / presupposes / necessaryFor / identical).
  const midAng = (kindDef && kindDef.rotateWithFlow)
    ? Math.atan2(cp2y - cp1y, cp2x - cp1x) * 180 / Math.PI
    : 0;
  const midXform = midAng
    ? `translate(${midX} ${midY}) rotate(${midAng})`
    : `translate(${midX} ${midY})`;
  if (kindDef && kindDef.weighted) {
    // Widened pill: glyph in the left half, editable weight value in the right.
    const b = getPillBounds(arrow, EDGE_KINDS);
    const hw = b ? b.halfW : 30;
    const hh = b ? b.halfH : 15;
    const weight = arrow.probWeight != null ? arrow.probWeight : 50;
    parts.push(
      `<g transform="${midXform}">` +
        `<rect x="${-hw}" y="${-hh}" width="${hw * 2}" height="${hh * 2}" ` +
          `rx="${hh}" ry="${hh}" fill="${theme.pillBg}" stroke="${color}" stroke-width="1.8"/>` +
        `<g transform="translate(${-hw + 15} 0)">${renderGlyph(kindDef.glyph, color)}</g>` +
        `<line x1="${hw - 30}" y1="${-hh + 5}" x2="${hw - 30}" y2="${hh - 5}" stroke="${color}" stroke-width="1" opacity="0.45"/>` +
        `<text x="${hw - 15}" y="1" text-anchor="middle" dominant-baseline="middle" fill="${color}" ` +
          `font-family="system-ui, sans-serif" font-size="13" font-weight="700">${esc(String(weight))}</text>` +
      `</g>`
    );
  } else if (kindDef && kindDef.render === 'glyph') {
    parts.push(
      `<g transform="${midXform}">` +
        `<circle r="15" fill="${theme.pillBg}" stroke="${color}" stroke-width="1.8"/>` +
        renderGlyph(kindDef.glyph, color) +
      `</g>`
    );
  } else if (kindDef && kindDef.render === 'text') {
    const b = getPillBounds(arrow, EDGE_KINDS);
    const pw = (b ? b.halfW : 20) * 2;
    const ph = (b ? b.halfH : 15) * 2;
    const glyph = kindDef.icon
      ? `<path d="${kindDef.icon}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
      : arrow.kind === 'xor'
      // XOR — circle quartered by a full-diameter cross.
      ? `<circle r="9" fill="none" stroke="${color}" stroke-width="2"/>` +
        `<line x1="-9" y1="0" x2="9" y2="0" stroke="${color}" stroke-width="2"/>` +
        `<line x1="0" y1="-9" x2="0" y2="9" stroke="${color}" stroke-width="2"/>`
      : `<text x="0" y="1" text-anchor="middle" dominant-baseline="middle" fill="${color}" ` +
          `font-family="system-ui, sans-serif" font-size="22" font-weight="700">${esc(kindDef.symbol)}</text>`;
    parts.push(
      `<g transform="${midXform}">` +
        `<rect x="${-pw / 2}" y="${-ph / 2}" width="${pw}" height="${ph}" ` +
          `rx="${ph / 2}" ry="${ph / 2}" fill="${theme.pillBg}" stroke="${color}" stroke-width="1.8"/>` +
        glyph +
      `</g>`
    );
  }

  // Label below midpoint
  if (arrow.label && String(arrow.label).trim()) {
    parts.push(
      `<text x="${midX}" y="${midY + 24}" text-anchor="middle" ` +
        `font-family="system-ui, sans-serif" font-size="12" fill="${theme.text}">` +
        `${esc(arrow.label)}</text>`
    );
  }

  return parts.join('');
}

/* ----------------------------------------------------------------
   Public: build the full SVG string for a board state.

   `options.viewportOnly` (default true) → export the world-coords
   rectangle that's currently visible on screen, so the user gets a
   "screenshot of what they see", not the whole infinite board.
   ---------------------------------------------------------------- */
export function buildExportSvg(state, options = {}) {
  const light = typeof document !== 'undefined' &&
                document.body.classList.contains('light-theme');
  const theme = getTheme(light);
  const viewportOnly = options.viewportOnly !== false;

  let bb;
  if (viewportOnly && state.viewport && typeof window !== 'undefined') {
    // Convert the on-screen viewport rect into world coordinates. Screen
    // point (sx, sy) maps to world ((sx - panX) / zoom, (sy - panY) / zoom).
    const { panX, panY, zoom } = state.viewport;
    const sw = window.innerWidth, sh = window.innerHeight;
    bb = {
      x: -panX / zoom,
      y: -panY / zoom,
      w: sw / zoom,
      h: sh / zoom,
    };
  } else {
    bb = computeBounds(state);
  }

  const regionSvg = Object.values(state.regions || {})
    .map(r => renderRegion(r))
    .join('');
  const nodeSvg = Object.values(state.nodes || {})
    .map(n => renderNode(n, theme))
    .join('');
  const arrowSvg = Object.values(state.arrows || {})
    .map(a => renderArrow(a, state, theme))
    .join('');

  // SVG width/height match the on-screen pixel dimensions (sw × sh) when
  // exporting the viewport — so the rasterised result is the same
  // resolution the user is looking at (modulo pixelRatio bump). For full-
  // board export the SVG size is just the bbox in world units.
  let outW, outH;
  if (viewportOnly && typeof window !== 'undefined') {
    outW = window.innerWidth;
    outH = window.innerHeight;
  } else {
    outW = bb.w;
    outH = bb.h;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${outW}" height="${outH}" ` +
      `viewBox="${bb.x} ${bb.y} ${bb.w} ${bb.h}">` +
      `<rect x="${bb.x}" y="${bb.y}" width="${bb.w}" height="${bb.h}" fill="${theme.bg}"/>` +
      // Z-order matches on-screen: regions (back) → arrows → nodes (front)
      `<g>${regionSvg}</g>` +
      `<g>${arrowSvg}</g>` +
      `<g>${nodeSvg}</g>` +
    `</svg>`
  );
}

/* ----------------------------------------------------------------
   Public: rasterise an SVG string onto a high-DPI <canvas>.
   ---------------------------------------------------------------- */
export async function svgToCanvas(svg, pixelRatio = 2) {
  // Use a data: URL with explicit UTF-8 encoding rather than a Blob —
  // some browsers (Safari especially) hand a Blob's content to the SVG
  // parser in a way that drops non-ASCII glyphs (¬, ∧, ⇒, etc.) and
  // then the load silently fails.
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('SVG image load failed'));
    img.src = dataUrl;
  });
  let w = img.width  || img.naturalWidth  || 800;
  let h = img.height || img.naturalHeight || 600;
  // Cap total canvas area so we don't blow past the browser's max canvas
  // memory limit (Chrome ~268M px², Safari less). 16M px² is plenty for
  // a print-grade export.
  const MAX_AREA = 16 * 1024 * 1024;
  let effectiveRatio = pixelRatio;
  const desiredArea = w * h * pixelRatio * pixelRatio;
  if (desiredArea > MAX_AREA) {
    effectiveRatio = Math.sqrt(MAX_AREA / (w * h));
  }
  // Also cap per-axis (some browsers reject canvases above ~16384px wide).
  const MAX_DIM = 16384;
  while ((w * effectiveRatio > MAX_DIM || h * effectiveRatio > MAX_DIM) && effectiveRatio > 0.1) {
    effectiveRatio *= 0.9;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * effectiveRatio));
  canvas.height = Math.max(1, Math.round(h * effectiveRatio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(effectiveRatio, 0, 0, effectiveRatio, 0, 0);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}
