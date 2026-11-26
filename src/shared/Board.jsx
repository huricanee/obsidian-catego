import { useLayoutEffect, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import Canvas, { NEW_NODE_W, NEW_NODE_H, MIN_ZOOM, MAX_ZOOM } from './Canvas.jsx';
import { NODE_KINDS, NODE_KIND_ORDER, EDGE_KINDS, EDGE_KIND_ORDER, NODE_STATUSES, NODE_STATUS_ROWS, FONT_FAMILY_ORDER, FONT_FAMILY_LABEL, DEFAULT_FONT_SIZE } from './argTypes.js';

// Arrow kinds that fold n-ary participants instead of nesting another pill.
const MERGEABLE_KINDS = new Set(['and', 'or', 'identical']);

// Logic-panel layout: explicit rows (paired/triple grid) for node & arrow kinds.
const LOGIC_NODE_ROWS = [
  ['definition', 'axiom', 'postulate'],
  ['premise', 'assumption', 'belief'],
  ['thesis', 'fact'],
  ['objection', 'response'],
  ['question', 'conclusion'],
  ['source', 'scope'],
];
// Arrow kinds are grouped: formal connectives vs how real thinking moves.
const LOGIC_ARROW_ROWS_MATH = [
  ['and', 'or', 'xor'],
  ['implies', 'equivalently'],
];
const LOGIC_ARROW_ROWS_REAL = [
  ['therefore', 'because'],
  ['but', 'inOrderTo'],
  ['necessaryFor', 'sufficientFor'],
  ['probDecreases', 'probIncreases'],
  ['supports', 'contradicts', 'presupposes'],
  ['refines', 'generalizes'],
  ['example', 'counterExample'],
  ['analogy', 'identical'],
];
// Hotkey labels for the properties-panel chips. Keep in sync with the
// NODE_KIND_OF / NODE_KIND_CMD / ARROW_KIND_OF / ARROW_KIND_CMD maps in the
// Shift+letter keyboard handler.
const NODE_KIND_HK = {
  definition: '⇧D', axiom: '⌘⇧A', postulate: '⇧P',
  premise: '⌘⇧P', assumption: '⇧U', belief: '⇧B',
  thesis: '⇧T', fact: '⇧F', objection: '⇧O', response: '⇧R',
  question: '⇧Q', conclusion: '⇧C', source: '⇧S', scope: '⌘⇧S',
};
const ARROW_KIND_HK = {
  and: '⇧A', or: '⇧O', xor: '⇧X',
  implies: '⇧I', therefore: '⇧T', equivalently: '⇧E',
  necessaryFor: '⇧N', sufficientFor: '⌘⇧S',
  probDecreases: '⇧P·−', probIncreases: '⇧P·=',
  supports: '⇧S', contradicts: '⇧C', presupposes: '⇧P',
  refines: '⇧R', generalizes: '⇧G',
  example: '⌘⇧E', counterExample: '⌘⇧X',
  analogy: '⇧`', identical: '⇧=',
  because: '⇧B', but: '⇧U', inOrderTo: '⇧F',
};
// Shift+digit → colour (matches COLOR_OF in the keyboard handler).
const COLOR_HK = {
  '#868e96': '1', '#ff6b6b': '2', '#ffa94d': '3', '#ffd43b': '4',
  '#69db7c': '5', '#38d9a9': '6', '#4dabf7': '7', '#cf7bf0': '8',
  '#f783ac': '9', '#ffffff': '0',
};
import { jsPDF } from 'jspdf';
import { buildExportSvg, svgToCanvas, invertCanvas } from './exportSvg.js';
import { buildGraphFromDsl } from './dslImport.js';
import { serializeToDsl } from './dslExport.js';
import { PAPERS, PAGE_BGS, makeDoc, normalizeDoc, docLayout as computeDocLayout, clampViewport, fitPageViewport, pageIndexAt, contentBounds, insertPage, deletePage, movePage, duplicatePage, shiftBelow, sliceRect, pageOfY } from './pages.js';
import { makePdfService } from './pdf.js';
import { applyAgentOps } from './agentOps.js';
import PagePanel from './PagePanel.jsx';

// A touch screen is present (iPad, touch laptop): pen options collapse while
// writing, finger gestures are live.
const TOUCH = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
// Copy / paste buffer. Module-level so it survives switching boards in the
// same window; the system clipboard carries it across windows.
let boardClipboard = null;

/* ================================================================
   Mobile detection hook
   ================================================================ */
function useMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

/* ================================================================
   Constants
   ================================================================ */
// Fresh node size lives in Canvas.jsx (NEW_NODE_W/H) so every spawn path agrees.
const NEW_W = NEW_NODE_W, NEW_H = NEW_NODE_H;
const SAVE_DEBOUNCE = 500;
const MAX_HISTORY = 50;
// Multi-selection: object type → the Set key in `selection`.
const SEL_KEY = { node: 'nodeIds', arrow: 'arrowIds', region: 'regionIds', stroke: 'strokeIds' };

const PALETTE = [
  '#868e96', '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c',
  '#38d9a9', '#4dabf7', '#cf7bf0', '#f783ac', '#ffffff',
];

// Three pens and three highlighters, each with its own colour / width /
// opacity (as in a notebook app): picking a slot picks all three at once, and
// changing a setting changes the slot in hand.
const defaultPens = () => ({
  pen: [
    { color: '#ffffff', width: TOUCH ? 2 : 4, opacity: 100 },
    { color: '#4dabf7', width: TOUCH ? 2 : 4, opacity: 100 },
    { color: '#ff6b6b', width: TOUCH ? 2 : 4, opacity: 100 },
  ],
  highlighter: [
    { color: '#ffd43b', width: 14, opacity: 35 },
    { color: '#69db7c', width: 14, opacity: 35 },
    { color: '#f783ac', width: 14, opacity: 35 },
  ],
});
function loadPens(raw) {
  const base = defaultPens();
  try {
    const j = JSON.parse(raw || 'null');
    for (const kind of ['pen', 'highlighter']) {
      if (!j || !Array.isArray(j[kind])) continue;
      base[kind] = base[kind].map((d, i) => {
        const v = j[kind][i];
        return v && typeof v.color === 'string' && v.width > 0 ? { color: v.color, width: Number(v.width), opacity: Math.max(1, Math.min(100, Number(v.opacity) || 100)) } : d;
      });
    }
  } catch { /* defaults */ }
  return base;
}
const IMAGE_MAX_EMBED = 1600; // px — pictures kept inside the board (no asset store) are downscaled to this

let nextId = 1;
function genId(prefix = 'n') {
  return prefix + (nextId++) + '_' + Date.now().toString(36);
}

// Alt+Enter inside an editing node: start a new list item, continuing the
// current line's marker (bullet / numbered / todo) or starting a bullet.
function insertListItemAtCaret() {
  const sel = window.getSelection();
  const el = document.activeElement;
  if (!sel || !sel.rangeCount || !el) { document.execCommand('insertLineBreak'); return; }
  let before = '';
  try {
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.endContainer, range.endOffset);
    before = pre.toString();
  } catch { before = ''; }
  const line = before.slice(before.lastIndexOf('\n') + 1);
  let marker = '- ', m;
  if ((m = line.match(/^(\s*)- \[[ xX]\]\s/))) marker = `${m[1]}- [ ] `;
  else if ((m = line.match(/^(\s*)([-*])\s/))) marker = `${m[1]}${m[2]} `;
  else if ((m = line.match(/^(\s*)(\d+)\.\s/))) marker = `${m[1]}${parseInt(m[2], 10) + 1}. `;
  document.execCommand('insertText', false, '\n' + marker);
}

/* ================================================================
   Load persisted state
   ================================================================ */
function defaultState(zoom = 1) {
  const id = genId();
  return {
    nodes: {
      [id]: { id, x: 200, y: 200, text: 'Welcome to Catego!', color: '#cf7bf0', width: 220 },
    },
    arrows: {},
    strokes: [],
    regions: {},
    doc: null, // paged-document setup (src/pages.js) — null = infinite board
    viewport: { panX: 0, panY: 0, zoom },
  };
}

/* ================================================================
   History snapshot helpers
   ================================================================ */
function takeSnapshot(state) {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)),
    arrows: JSON.parse(JSON.stringify(state.arrows)),
    // Ink is shared by reference: stroke objects are never mutated (every edit
    // makes a new object / array), and deep-cloning a page of handwriting on
    // each stroke — times 50 undo steps — is what made long pages crawl.
    strokes: state.strokes || [],
    regions: JSON.parse(JSON.stringify(state.regions || {})),
    // Sheet backgrounds move with page operations, so they are part of undo.
    bgs: (state.doc && state.doc.bgs) || null,
  };
}
const sameBgs = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
function docWithBgs(doc, bgs) {
  if (!doc || sameBgs(doc.bgs, bgs)) return doc;
  const next = { ...doc };
  if (bgs) next.bgs = bgs; else delete next.bgs;
  return next;
}

function applySnapshot(state, snapshot) {
  return {
    ...state,
    nodes: snapshot.nodes,
    arrows: snapshot.arrows,
    strokes: snapshot.strokes,
    regions: snapshot.regions || {},
    doc: 'bgs' in snapshot ? docWithBgs(state.doc, snapshot.bgs) : state.doc,
  };
}

// Default per-viewer preferences: kept in memory only. Hosts pass a
// persistent store (the web app: browser storage; Obsidian: plugin data).
function makeMemoryPrefs() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
}

// Default sync: none. Hosts with a server pass their own hook (same signature).
function useNoSync() {
  const send = useCallback(() => {}, []);
  const suppressRef = useRef(false);
  return { send, users: [], connected: false, suppressRef };
}

/* ================================================================
   BOARD — the one board editor, shared by every host.
   ================================================================
   Hosts (the browser shell src/App.jsx, the Obsidian view) only decide where
   the board comes from and where it goes; everything a user can do on the
   board lives here, so a change made here reaches every host.

   initial            { nodes, arrows, regions, strokes, notes?, viewport? } —
                      null → a fresh board with the welcome node
   onPersist(graph)   debounced save of { nodes, arrows, regions, strokes, notes, viewport }
   useSyncHook        ({ getState, applyDelta, replaceState }) → { send, users, connected, suppressRef };
                      must keep the same identity for the board's lifetime
   overlay            host UI rendered on top of the board (board picker, login, …)
   renderRegionExtras (regionId) → extra rows in the region properties panel
   isolateKeys        stop board keystrokes from reaching the host app (Obsidian)
   prefs              { get(key) → string|null, set(key, string) } — per-viewer UI
                      preferences (panel open, theme, LaTeX source mode)
   defaultZoom        zoom of a fresh board and of "reset zoom" (0 / fit on empty board)
   onOpenNote / onRenameNoteFile / bridge — note-backed nodes (Obsidian)
   assets             { save(blob, name) → Promise<src>, url(src) → Promise<url>,
                      data(src) → Promise<ArrayBuffer> } — where pictures and PDFs
                      live (vault files, IndexedDB…). Without it pictures are
                      embedded in the board and PDFs can't be imported.
   loadPdfJs          () → Promise<pdf.js library> — the host's PDF engine
                      (both must keep the same identity for the board's lifetime)
   ================================================================ */
export default function Board({
  initial = null, onPersist, useSyncHook = useNoSync, overlay = null,
  renderRegionExtras = null, isolateKeys = false, defaultZoom = 1, prefs: prefsProp = null,
  onOpenNote, onRenameNoteFile, bridge, assets = null, loadPdfJs = null,
  // (title, markdown) → the host stores a generated note next to the board.
  onSaveNote = null,
}) {
  const isMobile = useMobile();
  const rootRef = useRef(null);
  const [prefs] = useState(() => prefsProp || makeMemoryPrefs());
  // nodeId -> vault path for note-backed nodes.
  const [notes, setNotes] = useState(() => (initial && initial.notes) || {});

  const initialState = () => {
    const base = defaultState(defaultZoom);
    if (!initial) return base;
    return {
      ...base,
      nodes: initial.nodes || {},
      arrows: initial.arrows || {},
      regions: initial.regions || {},
      strokes: initial.strokes || [],
      doc: normalizeDoc(initial.doc),
      viewport: initial.viewport || base.viewport,
    };
  };

  const [state, setState] = useState(initialState);
  const pdf = useMemo(() => makePdfService(loadPdfJs, assets), [loadPdfJs, assets]);
  const pdfService = pdf; // (`pdf` is also the jsPDF document's name in the exporter)
  // Paged document: page rectangles + the area the view may roam (null = infinite).
  const layout = useMemo(
    () => computeDocLayout(state.doc, state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.doc, state.nodes, state.regions, state.strokes, state.arrows],
  );
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedType, setSelectedType] = useState(null); // 'node' | 'arrow' | null
  const [editingNodeId, setEditingNodeId] = useState(null); // node currently in text edit (lifted from Canvas)

  // Vim-mode: 'dev' (commands over the graph) | 'edit' (typing into one node).
  // Tab toggles. When entering 'edit' we pick the last-edited node (if it
  // still exists) or the node closest to viewport center.
  const [mode, setMode] = useState('dev');
  const lastEditedRef = useRef(null);

  // Track who is being edited so we can save them as last-edited on Tab.
  useEffect(() => {
    if (editingNodeId) lastEditedRef.current = editingNodeId;
  }, [editingNodeId]);

  // Iron rule: mode follows editingNodeId. If a node is being edited
  // (caret in node text — by click, by Enter, by anything), mode is
  // 'edit'. Otherwise 'dev'. This guarantees the badge and the edit/dev
  // logic stay in lock-step regardless of how the edit started.
  useEffect(() => {
    if (editingNodeId && mode !== 'edit') setMode('edit');
    else if (!editingNodeId && mode === 'edit') setMode('dev');
  }, [editingNodeId, mode]);

  // Unified tool mode: 'select' | 'move' | 'draw' | 'eraser'
  // Mobile defaults to 'move' (pan + drag nodes), desktop to 'select'
  const [toolMode, setToolMode] = useState(isMobile ? 'move' : 'select');
  // Pen options panel (colour / width / opacity). Always there with a mouse;
  // on a touch screen it opens on demand (tap the pen button again, or
  // long-press the board with a finger) and closes once you write.
  const [penPanelOpen, setPenPanelOpen] = useState(true);
  // Options bars of the other tools: pressing the active tool's button again
  // hides / shows its bar (remembered).
  const [optsHidden, setOptsHidden] = useState(() => {
    try { return JSON.parse(prefs.get('catego-opts-hidden') || '{}') || {}; } catch { return {}; }
  });
  const toggleOpts = useCallback((key) => setOptsHidden((h) => {
    const next = { ...h, [key]: !h[key] };
    prefs.set('catego-opts-hidden', JSON.stringify(next));
    return next;
  }), [prefs]);
  // A stylus has been used on this device: from then on fingers only scroll,
  // zoom and tap — they never draw (remembered, so it holds from the first
  // touch of every later session).
  const [penOnly, setPenOnly] = useState(() => prefs.get('catego-pen-seen') === 'true');
  const onPenSeen = useCallback(() => { setPenOnly(true); prefs.set('catego-pen-seen', 'true'); }, [prefs]);
  // Options of a multi-selection: a popup next to the selection, opened by
  // clicking the selected objects (world-space bounds of the selection).
  const [selPopup, setSelPopup] = useState(null);
  const selPopupRef = useRef(null);
  // Properties panel: every property is one `name: value` line; the one
  // named here is unfolded to show its choices.
  const [openProp, setOpenProp] = useState(null);
  // Functions toolbar (top-right corner): collapsed to undo / redo / "more" so
  // a writing hand has nothing to brush against; "more" unfolds the rest.
  const [fnOpen, setFnOpen] = useState(false);
  // Pen kind: 'pen' or 'highlighter' (wide, translucent, constant width). Each
  // keeps its own colour / width / opacity; the other one's are parked here.
  const [penKind, setPenKind] = useState('pen');
  // Select tool: drag a rectangle, or draw a free loop (lasso).
  const [selectKind, setSelectKind] = useState('rect');
  // What a rectangle / lasso picks up: everything, only ink, or only objects.
  const [selectFilter, setSelectFilter] = useState('all');
  // Eraser: what it may rub out, and whether it hands back to the pen after one go.
  const [eraserTarget, setEraserTarget] = useState('all'); // 'all' | 'ink' | 'pen' | 'hl'
  const [eraserAuto, setEraserAuto] = useState(false);
  // Highlighter draws ruler-straight lines (start → end).
  const [hlStraight, setHlStraight] = useState(() => prefs.get('catego-hl-straight') !== 'false');
  useEffect(() => { prefs.set('catego-hl-straight', String(hlStraight)); }, [hlStraight, prefs]);
  // Highlighter on a PDF page marks the page's own text (when it starts on text).
  const [hlText, setHlText] = useState(() => prefs.get('catego-hl-text') !== 'false');
  useEffect(() => { prefs.set('catego-hl-text', String(hlText)); }, [hlText, prefs]);
  // Page strip (paged documents).
  const [pagesOpen, setPagesOpen] = useState(false);
  // Page-setup popover (infinite board ⇄ sheets).
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  // Finger gestures (see the touch adapter in Canvas.jsx).
  const toolModeRef = useRef(toolMode);
  const lastToolRef = useRef('draw'); // last tool that wasn't the eraser
  useEffect(() => {
    toolModeRef.current = toolMode;
    if (toolMode !== 'eraser') lastToolRef.current = toolMode;
  }, [toolMode]);
  // Quick double tap with one finger: eraser ⇄ the tool used before it.
  // (Two-finger tap = undo, three-finger tap = redo — wired at <Canvas>.)
  const onDoubleTap = useCallback(() => {
    setToolMode(toolModeRef.current === 'eraser' ? (lastToolRef.current || 'draw') : 'eraser');
  }, []);
  // Long press: pen options (switching to the pen if needed).
  const onFingerLongPress = useCallback(() => {
    if (toolModeRef.current === 'draw') setPenPanelOpen((v) => !v);
    else { setToolMode('draw'); setPenPanelOpen(true); }
  }, []);
  // Pens: three slots per kind (see defaultPens); the one in hand supplies
  // colour / width / opacity, and editing those edits the slot.
  const [pens, setPens] = useState(() => loadPens(prefs.get('catego-pens')));
  const [penSlot, setPenSlot] = useState({ pen: 0, highlighter: 0 });
  useEffect(() => { prefs.set('catego-pens', JSON.stringify(pens)); }, [pens, prefs]);
  const curPen = pens[penKind][penSlot[penKind]] || pens[penKind][0];
  const drawColor = curPen.color, drawWidth = curPen.width, drawOpacity = curPen.opacity;
  const updatePen = useCallback((patch) => {
    setPens((prev) => ({ ...prev, [penKind]: prev[penKind].map((v, i) => (i === penSlot[penKind] ? { ...v, ...patch } : v)) }));
  }, [penKind, penSlot]);
  const setDrawColor = useCallback((color) => updatePen({ color }), [updatePen]);
  const setDrawWidth = useCallback((width) => updatePen({ width }), [updatePen]);
  const setDrawOpacity = useCallback((opacity) => updatePen({ opacity }), [updatePen]);

  // When on, the selected arrow shows Illustrator-style bezier control
  // handles you can drag to reshape its curve.
  const [showArrowHandles, setShowArrowHandles] = useState(false);

  // LaTeX source mode toggle (show raw LaTeX in all nodes)
  const [sourceMode, setSourceMode] = useState(() => prefs.get('catego-source-mode') === 'true');

  // Light theme — implemented as a global CSS `filter: invert(1) hue-rotate(180deg)`
  // on the document body, applied via a class. Hue-rotate keeps colors looking
  // roughly correct (red stays red, blue stays blue). A second filter on <img>
  // and <video> cancels the outer inversion so photos/logos render normally.
  const [lightTheme, setLightTheme] = useState(() => prefs.get('catego-light-theme') === 'true');
  useEffect(() => {
    document.body.classList.toggle('light-theme', lightTheme);
    prefs.set('catego-light-theme', String(lightTheme));
  }, [lightTheme, prefs]);
  const toggleLightTheme = useCallback(() => setLightTheme((v) => !v), []);

  // Print menu — pops out JPEG / PDF export options below the Print button.
  const [printMenuOpen, setPrintMenuOpen] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);

  // Figure menu — pops out shape choices below the Figure tool button.
  const [figureMenuOpen, setFigureMenuOpen] = useState(false);

  // Keyboard shortcuts cheat-sheet overlay (toggled with `?`).
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Highlight-color picker (markdown formatting toolbar).
  const [highlightOpen, setHighlightOpen] = useState(false);
  // DSL import modal.
  const [dslOpen, setDslOpen] = useState(false);
  // Properties panel — opens only via the ` hotkey, not on selection.
  const [propsOpen, setPropsOpen] = useState(() => {
    return prefs.get('catego-props-open') !== 'false';
  });
  useEffect(() => {
    prefs.set('catego-props-open', String(propsOpen));
  }, [propsOpen, prefs]);

  // Placement tools: toolMode 'node' | 'region' | 'figure' — click or drag on
  // the canvas to create the object (Excalidraw-style). For 'figure', the
  // shape is held here. `9` arms a pending figure that 1–5 then picks.
  const [figureShape, setFigureShape] = useState('rect');
  const figurePendingRef = useRef(0); // timestamp of a pending `9` (awaiting 1–5)
  const hotkeyRef = useRef({ pen: () => {}, text: () => {} });
  useEffect(() => {
    if (!printMenuOpen) return;
    function onDocDown(e) {
      const menu = document.getElementById('print-menu');
      const btn = document.getElementById('print-btn');
      if (menu && (menu.contains(e.target) || (btn && btn.contains(e.target)))) return;
      setPrintMenuOpen(false);
    }
    window.addEventListener('mousedown', onDocDown);
    return () => window.removeEventListener('mousedown', onDocDown);
  }, [printMenuOpen]);

  useEffect(() => {
    if (!pageMenuOpen) return;
    function onDocDown(e) {
      const menu = document.getElementById('page-menu');
      const btn = document.getElementById('page-btn');
      if ((menu && menu.contains(e.target)) || (btn && btn.contains(e.target))) return;
      setPageMenuOpen(false);
    }
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('touchstart', onDocDown);
    return () => { window.removeEventListener('mousedown', onDocDown); window.removeEventListener('touchstart', onDocDown); };
  }, [pageMenuOpen]);

  const exportCanvas = useCallback(async (format, { whole = false } = {}) => {
    setPrintBusy(true);
    setPrintMenuOpen(false);
    try {
      // High-DPI: cap at 3× to avoid running out of canvas memory on big boards.
      const pixelRatio = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      // whole:true renders the ENTIRE board at world scale — every node at its
      // real size, so text stays crisp and nothing is hidden no matter how far
      // out the user is zoomed. Otherwise we capture just the current viewport.
      // Pictures are embedded: an SVG rasterised through <img> can't load them itself.
      const images = {};
      for (const n of Object.values(state.nodes)) {
        if (n.shape !== 'image' || !n.image || images[n.image]) continue;
        try {
          if (/^data:/.test(n.image)) { images[n.image] = n.image; continue; }
          if (!assets || !assets.data) continue;
          const buf = await assets.data(n.image);
          if (!buf) continue;
          const ext = (n.image.split('.').pop() || '').toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg';
          images[n.image] = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(new Blob([buf], { type: mime })); });
        } catch { /* left as a frame */ }
      }
      // A paged document prints as a real multi-page PDF: one sheet per page
      // (the trailing blank sheet is left out).
      if (format === 'pdf' && layout) {
        const sheets = layout.pages.slice(0, Math.max(1, layout.count - 1));
        const orientation = layout.w >= layout.h ? 'landscape' : 'portrait';
        const pdf = new jsPDF({ orientation, unit: 'px', format: [layout.w, layout.h], compress: true });
        const light = document.body.classList.contains('light-theme');
        for (let i = 0; i < sheets.length; i++) {
          const part = sliceRect(state, sheets[i]);
          let sheetCanvas;
          if (sheets[i].bg && pdfService) {
            // A PDF sheet: the page itself, then the writing on top of it.
            sheetCanvas = await pdfService.renderPage(sheets[i].bg.src, sheets[i].bg.page, layout.w * 2).catch(() => null);
            if (sheetCanvas && !light) invertCanvas(sheetCanvas);
            const ink = await svgToCanvas(buildExportSvg(part, { rect: sheets[i], transparent: true, images }), 2);
            if (sheetCanvas) sheetCanvas.getContext('2d').drawImage(ink, 0, 0, sheetCanvas.width, sheetCanvas.height);
            else sheetCanvas = ink;
          } else {
            sheetCanvas = await svgToCanvas(buildExportSvg(part, { rect: sheets[i], paper: layout.bg, images }), 2);
          }
          if (i > 0) pdf.addPage([layout.w, layout.h], orientation);
          pdf.addImage(sheetCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, layout.w, layout.h);
        }
        pdf.save(`catego-${ts}.pdf`);
        return;
      }
      const svg = buildExportSvg(state, { viewportOnly: !whole, images });
      const canvas = await svgToCanvas(svg, pixelRatio);
      const suffix = whole ? '-board' : '';
      if (format === 'png') {
        const dataUrl = canvas.toDataURL('image/png');
        if (!dataUrl || dataUrl === 'data:,') {
          throw new Error('Canvas produced an empty image (likely exceeded browser memory limit)');
        }
        const a = document.createElement('a');
        a.download = `catego${suffix}-${ts}.png`;
        a.href = dataUrl;
        // Some browsers ignore .click() on detached anchors.
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else if (format === 'jpeg') {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        if (!dataUrl || dataUrl === 'data:,') {
          throw new Error('Canvas produced an empty image (likely exceeded browser memory limit)');
        }
        const a = document.createElement('a');
        a.download = `catego${suffix}-${ts}.jpg`;
        a.href = dataUrl;
        // Some browsers ignore .click() on detached anchors.
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else if (format === 'pdf') {
        const dataUrl = canvas.toDataURL('image/png');
        const w = canvas.width;
        const h = canvas.height;
        const orientation = w >= h ? 'landscape' : 'portrait';
        const pdf = new jsPDF({ orientation, unit: 'px', format: [w, h], compress: true });
        pdf.addImage(dataUrl, 'PNG', 0, 0, w, h);
        pdf.save(`catego${suffix}-${ts}.pdf`);
      }
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed: ' + (err.message || err));
    } finally {
      setPrintBusy(false);
    }
  }, [state, layout, assets, pdfService]);

  const toggleSourceMode = useCallback(() => {
    setSourceMode(prev => {
      const next = !prev;
      prefs.set('catego-source-mode', String(next));
      return next;
    });
  }, [prefs]);

  // Draw options panel (double-tap draw button)
  const [showDrawOptions, setShowDrawOptions] = useState(false);

  // Eraser state
  const [eraserMode, setEraserMode] = useState('object'); // 'object' | 'pixel'
  const [eraserRadius, setEraserRadius] = useState(16);

  // Rectangle selection state
  const [selection, setSelection] = useState({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set(), regionIds: new Set() });

  // Undo/Redo history
  // history[0] MUST be the board as loaded from the .catego file: undoing the
  // first edit re-applies it. (It used to be defaultState(), so the first
  // Cmd+Z after opening replaced the whole board with the welcome node.)
  const [history, setHistory] = useState(() => [takeSnapshot(state)]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyLock = useRef(false); // prevent pushing history during undo/redo

  const { nodes, arrows, viewport, strokes = [], regions = {} } = state;

  // --- Real-time sync ---
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const applyDelta = useCallback((delta) => {
    setState(prev => {
      switch (delta.type) {
        case 'node:add':
          return { ...prev, nodes: { ...prev.nodes, [delta.node.id]: delta.node } };
        case 'node:update': {
          const existing = prev.nodes[delta.id];
          if (!existing) return prev;
          return { ...prev, nodes: { ...prev.nodes, [delta.id]: { ...existing, ...delta.updates } } };
        }
        case 'node:delete': {
          const newNodes = { ...prev.nodes };
          delete newNodes[delta.id];
          const newArrows = {};
          for (const [aId, a] of Object.entries(prev.arrows)) {
            if (a.fromNodeId !== delta.id && a.toNodeId !== delta.id) newArrows[aId] = a;
          }
          return { ...prev, nodes: newNodes, arrows: newArrows };
        }
        case 'arrow:add':
          return { ...prev, arrows: { ...prev.arrows, [delta.arrow.id]: delta.arrow } };
        case 'arrow:update': {
          const ea = prev.arrows[delta.id];
          if (!ea) return prev;
          return { ...prev, arrows: { ...prev.arrows, [delta.id]: { ...ea, ...delta.updates } } };
        }
        case 'arrow:delete': {
          const newArrows = { ...prev.arrows };
          delete newArrows[delta.id];
          return { ...prev, arrows: newArrows };
        }
        case 'stroke:add':
          if ((prev.strokes || []).some((s) => s.id === delta.stroke.id)) return prev;
          return { ...prev, strokes: [...(prev.strokes || []), delta.stroke] };
        case 'stroke:update':
          return { ...prev, strokes: (prev.strokes || []).map(s => s.id === delta.id ? { ...s, ...delta.updates } : s) };
        case 'stroke:delete':
          return { ...prev, strokes: (prev.strokes || []).filter(s => s.id !== delta.id) };
        case 'stroke:pixel-erase':
          return { ...prev, strokes: delta.newStrokes };
        case 'region:add':
          return { ...prev, regions: { ...(prev.regions || {}), [delta.region.id]: delta.region } };
        case 'region:update': {
          const er = (prev.regions || {})[delta.id];
          if (!er) return prev;
          return { ...prev, regions: { ...prev.regions, [delta.id]: { ...er, ...delta.updates } } };
        }
        case 'region:delete': {
          const nr = { ...(prev.regions || {}) };
          delete nr[delta.id];
          return { ...prev, regions: nr };
        }
        case 'state:undo':
          return { ...prev, nodes: delta.state.nodes, arrows: delta.state.arrows, strokes: delta.state.strokes, regions: delta.state.regions || {} };
        case 'doc:update':
          return { ...prev, doc: normalizeDoc(delta.doc) };
        case 'erase:objects': {
          const nIds = new Set(delta.nodeIds || []);
          const aIds = new Set(delta.arrowIds || []);
          const sIds = new Set(delta.strokeIds || []);
          const nn = { ...prev.nodes }; for (const id of nIds) delete nn[id];
          const na = {}; for (const [aId, a] of Object.entries(prev.arrows)) {
            if (!aIds.has(aId) && !nIds.has(a.fromNodeId) && !nIds.has(a.toNodeId)) na[aId] = a;
          }
          const ns = (prev.strokes || []).filter(s => !sIds.has(s.id));
          return { ...prev, nodes: nn, arrows: na, strokes: ns };
        }
        default:
          return prev;
      }
    });
  }, []);

  const replaceState = useCallback((serverState) => {
    // Dedupe strokes by id — older sessions could have persisted duplicates
    // server-side, which would cause React key collisions on render.
    const seen = new Set();
    const strokes = (serverState.strokes || []).filter(
      (s) => (seen.has(s.id) ? false : (seen.add(s.id), true))
    );
    setState(prev => ({
      ...prev,
      nodes: serverState.nodes || {},
      arrows: serverState.arrows || {},
      strokes,
      regions: serverState.regions || {},
      // Older servers don't know about `doc` — keep the local one then.
      ...(serverState.doc !== undefined ? { doc: normalizeDoc(serverState.doc) } : {}),
    }));
  }, []);

  // eslint-disable-next-line no-unused-vars
  const { send, users, connected, suppressRef } = useSyncHook({
    getState: () => stateRef.current,
    applyDelta,
    replaceState,
  });

  /* ================================================================
     Persistence — debounced save to the host (file / browser storage)
     ================================================================ */
  const saveTimer = useRef(null);
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onPersist({
        nodes: state.nodes,
        arrows: state.arrows,
        regions: state.regions || {},
        strokes: state.strokes || [],
        doc: state.doc || null,
        notes,
        viewport: state.viewport,
      });
    }, SAVE_DEBOUNCE);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [state, notes, onPersist]);

  // Bridge for note-node actions coming from the view (drag&drop / menu / rename).
  useEffect(() => {
    if (!bridge) return;
    bridge.addNoteNodeAtScreen = (path, title, clientX, clientY) => {
      const rect = rootRef.current ? rootRef.current.getBoundingClientRect() : { left: 0, top: 0 };
      const vp = stateRef.current.viewport;
      const snap = (v) => Math.round(v / 20) * 20;
      const wx = snap((clientX - rect.left - vp.panX) / vp.zoom);
      const wy = snap((clientY - rect.top - vp.panY) / vp.zoom);
      const id = genId();
      const node = { id, x: wx, y: wy, width: 220, text: title, color: '#ffffff' };
      setState((p) => ({ ...p, nodes: { ...p.nodes, [id]: node } }));
      setNotes((n) => ({ ...n, [id]: path }));
      setSelectedId(id); setSelectedType('node');
    };
    bridge.renameNote = (oldPath, newPath, newTitle) => {
      setNotes((n) => {
        const next = {}; const affected = [];
        for (const [nid, p] of Object.entries(n)) { if (p === oldPath) { next[nid] = newPath; affected.push(nid); } else next[nid] = p; }
        if (affected.length) setState((s) => {
          const nn = { ...s.nodes };
          for (const nid of affected) if (nn[nid]) nn[nid] = { ...nn[nid], text: newTitle };
          return { ...s, nodes: nn };
        });
        return next;
      });
    };
  });

  // Isolate the board's keys from Obsidian's global hotkeys: while the pointer is
  // over the board (or a node is being edited), stop keydown/keyup from reaching
  // Obsidian. Board-level hotkeys are window-capture listeners, so a stop at
  // window-capture still lets them fire. But a key typed INTO a node (Enter,
  // Escape, the ⌃ LaTeX snippets) is handled by React's onKeyDown, which lives
  // on the React root container — below window. Those events are let through
  // at window and stopped at the container instead, right after React ran.
  const overRef = useRef(false);
  useEffect(() => {
    if (!isolateKeys) return;
    const root = rootRef.current;
    const container = root && root.parentElement; // the React root (Obsidian's view content)
    const onEnter = () => { overRef.current = true; };
    const onLeave = () => { overRef.current = false; };
    if (root) { root.addEventListener('mouseenter', onEnter); root.addEventListener('mouseleave', onLeave); }
    const typingInBoard = (e) => !!(root && e.target && e.target.isContentEditable && root.contains(e.target));
    const stop = (e) => {
      if (typingInBoard(e)) return; // React first; stopped at the container below
      if (overRef.current || (root && root.contains(document.activeElement))) e.stopPropagation();
    };
    const stopAfterReact = (e) => { if (typingInBoard(e)) e.stopPropagation(); };
    window.addEventListener('keydown', stop, true);
    window.addEventListener('keyup', stop, true);
    if (container) { container.addEventListener('keydown', stopAfterReact); container.addEventListener('keyup', stopAfterReact); }
    return () => {
      if (root) { root.removeEventListener('mouseenter', onEnter); root.removeEventListener('mouseleave', onLeave); }
      window.removeEventListener('keydown', stop, true);
      window.removeEventListener('keyup', stop, true);
      if (container) { container.removeEventListener('keydown', stopAfterReact); container.removeEventListener('keyup', stopAfterReact); }
    };
  }, [isolateKeys]);

  // node → note: when editing a note-backed node ends, rename the vault file to
  // match the node's (new) title. The vault 'rename' event then syncs the path.
  const prevEditing = useRef(null);
  useEffect(() => {
    const was = prevEditing.current;
    prevEditing.current = editingNodeId;
    if (was && was !== editingNodeId && notes[was] && onRenameNoteFile) {
      const node = stateRef.current.nodes[was];
      const title = (node && node.text ? String(node.text) : '').replace(/\s+/g, ' ').trim();
      if (title) onRenameNoteFile(notes[was], title);
    }
  }, [editingNodeId, notes, onRenameNoteFile]);

  /* ================================================================
     History management
     ================================================================ */
  // Use refs for history to avoid stale closure issues
  // Lazy-init so the board isn't deep-cloned on every render. Same seed as
  // `history` above — the file's initial state, never defaultState().
  const historyRef = useRef(null);
  if (historyRef.current === null) historyRef.current = [takeSnapshot(state)];
  const historyIndexRef = useRef(0);

  const pushHistorySnapshot = useCallback((newState) => {
    if (historyLock.current) return;
    const snap = takeSnapshot(newState);
    // Trim forward history
    const trimmed = historyRef.current.slice(0, historyIndexRef.current + 1);
    trimmed.push(snap);
    // Enforce max
    if (trimmed.length > MAX_HISTORY) {
      trimmed.shift();
    } else {
      historyIndexRef.current += 1;
    }
    historyRef.current = trimmed;
    // Update React state for toolbar button disabled states
    setHistory(trimmed);
    setHistoryIndex(historyIndexRef.current);
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyLock.current = true;
    historyIndexRef.current -= 1;
    const snap = historyRef.current[historyIndexRef.current];
    setState(prev => applySnapshot(prev, snap));
    send({ type: 'state:undo', state: snap });
    const curDoc = stateRef.current.doc;
    if (curDoc && 'bgs' in snap && !sameBgs(curDoc.bgs, snap.bgs)) send({ type: 'doc:update', doc: docWithBgs(curDoc, snap.bgs) });
    setHistoryIndex(historyIndexRef.current);
    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    setSelectedId(null);
    setSelectedType(null);
    setTimeout(() => { historyLock.current = false; }, 0);
  }, [send]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyLock.current = true;
    historyIndexRef.current += 1;
    const snap = historyRef.current[historyIndexRef.current];
    setState(prev => applySnapshot(prev, snap));
    send({ type: 'state:undo', state: snap });
    const curDoc = stateRef.current.doc;
    if (curDoc && 'bgs' in snap && !sameBgs(curDoc.bgs, snap.bgs)) send({ type: 'doc:update', doc: docWithBgs(curDoc, snap.bgs) });
    setHistoryIndex(historyIndexRef.current);
    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    setSelectedId(null);
    setSelectedType(null);
    setTimeout(() => { historyLock.current = false; }, 0);
  }, [send]);

  /* Helper: setState + push history */
  const setStateWithHistory = useCallback((updater) => {
    setState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Push history in a microtask to avoid batching issues
      queueMicrotask(() => pushHistorySnapshot(next));
      return next;
    });
  }, [pushHistorySnapshot]);

  /* ================================================================
     State updaters
     ================================================================ */
  const onUpdateViewport = useCallback((vp) => {
    // Document mode: the view can't leave the sheets.
    const lay = layoutRef.current, el = rootRef.current;
    const next = lay && el ? clampViewport(vp, lay, el.clientWidth, el.clientHeight) : vp;
    setState((prev) => ({ ...prev, viewport: next }));
  }, []);

  // Show page `index` (default: the one in view) at full width.
  const fitPage = useCallback((index = null, lay = layoutRef.current) => {
    const el = rootRef.current;
    if (!lay || !el) return;
    setState((prev) => {
      const i = index != null ? index : pageIndexAt(lay, (el.clientHeight / 3 - prev.viewport.panY) / prev.viewport.zoom);
      return { ...prev, viewport: fitPageViewport(lay, el.clientWidth, el.clientHeight, i) };
    });
  }, []);

  // Board setup: infinite canvas (null) or a paged document.
  const changeDoc = useCallback((patch) => {
    const st = stateRef.current;
    const cur = st.doc;
    let next;
    if (patch === null) next = null;
    else if (!cur) {
      // Converting an existing board: put the first sheet's corner just above
      // and left of what is already there.
      const cb = contentBounds(st);
      const down = (v) => Math.floor(v / 20) * 20;
      next = makeDoc(patch.paper || 'a4', patch.bg || 'ruled', cb ? { x: down(cb.x0 - 40), y: down(cb.y0 - 40) } : null);
    } else {
      next = normalizeDoc({ ...cur, ...patch, ...(patch.paper && PAPERS[patch.paper] ? { w: PAPERS[patch.paper].w, h: PAPERS[patch.paper].h } : {}) });
    }
    setState((prev) => ({ ...prev, doc: next }));
    send({ type: 'doc:update', doc: next });
    if (next && (!cur || patch.paper)) fitPage(cur ? null : 0, computeDocLayout(next, st));
  }, [send, fitPage]);

  // A document opened without a saved view starts on its first page.
  useEffect(() => {
    if (stateRef.current.doc && !(initial && initial.viewport)) fitPage(0, computeDocLayout(stateRef.current.doc, stateRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Pages are derived from the content: when the document shrinks, pull the
  // view back onto it.
  useEffect(() => {
    const el = rootRef.current;
    if (!layout || !el) return;
    setState((prev) => {
      const c = clampViewport(prev.viewport, layout, el.clientWidth, el.clientHeight);
      return c === prev.viewport ? prev : { ...prev, viewport: c };
    });
  }, [layout]);

  const onAddNode = useCallback((x, y) => {
    const id = genId();
    // New nodes start at 3×2 grid cells and widen with their text (fitWidth)
    // up to MAX_FIT_WIDTH; a manual resize turns fitting off.
    const node = { id, x, y, text: '', color: '#ffffff', width: NEW_W, height: NEW_H, fitWidth: true };
    setStateWithHistory((prev) => ({
      ...prev,
      nodes: { ...prev.nodes, [id]: node },
    }));
    send({ type: 'node:add', node });
    setSelectedId(id);
    setSelectedType('node');
    return id;
  }, [setStateWithHistory, send]);

  const onUpdateNode = useCallback((id, updates) => {
    setState((prev) => {
      const existing = prev.nodes[id];
      if (!existing) return prev;
      return {
        ...prev,
        nodes: { ...prev.nodes, [id]: { ...existing, ...updates } },
      };
    });
    send({ type: 'node:update', id, updates });
  }, [send]);

  // Push history after node drag ends (called from Canvas on mouseup)
  const onNodeDragEnd = useCallback(() => {
    setState(prev => {
      pushHistorySnapshot(prev);
      return prev;
    });
  }, [pushHistorySnapshot]);

  const onDeleteNode = useCallback((id) => {
    setStateWithHistory((prev) => {
      const newNodes = { ...prev.nodes };
      delete newNodes[id];
      // Drop arrows directly attached to this node, then cascade through
      // any arrows whose pill they referenced.
      const newArrows = { ...prev.arrows };
      const queue = [];
      const removed = new Set();
      for (const [aId, a] of Object.entries(newArrows)) {
        if (a.fromNodeId === id || a.toNodeId === id) queue.push(aId);
      }
      while (queue.length) {
        const victim = queue.shift();
        if (removed.has(victim)) continue;
        removed.add(victim);
        delete newArrows[victim];
        for (const [aId, a] of Object.entries(newArrows)) {
          if (a.fromPillArrowId === victim || a.toPillArrowId === victim) {
            queue.push(aId);
          }
        }
      }
      for (const v of removed) send({ type: 'arrow:delete', id: v });
      return { ...prev, nodes: newNodes, arrows: newArrows };
    });
    send({ type: 'node:delete', id });
    setSelectedId(null);
    setSelectedType(null);
  }, [setStateWithHistory, send]);

  // Endpoints can be a node-anchor, a region-anchor, or another arrow's pill:
  //   { nodeId, anchor }  OR  { regionId, anchor }  OR  { pillArrowId, anchor }
  const onAddArrow = useCallback((from, to) => {
    // Free-floating endpoints ({point:{x,y}}) are always unique — skip dedup.
    const hasFreePoint = from.point || to.point;
    // Dedup — anchors are part of the identity (different sides of the same
    // pill / node / region count as different connections).
    const fromKey = (a, end) => {
      if (from.pillArrowId) return a[`${end}PillArrowId`] === from.pillArrowId && a[`${end}Anchor`] === from.anchor;
      if (from.regionId)    return a[`${end}RegionId`]    === from.regionId    && a[`${end}Anchor`] === from.anchor;
      return                a[`${end}NodeId`]            === from.nodeId      && a[`${end}Anchor`] === from.anchor;
    };
    const toKey = (a, end) => {
      if (to.pillArrowId) return a[`${end}PillArrowId`] === to.pillArrowId && a[`${end}Anchor`] === to.anchor;
      if (to.regionId)    return a[`${end}RegionId`]    === to.regionId    && a[`${end}Anchor`] === to.anchor;
      return              a[`${end}NodeId`]            === to.nodeId      && a[`${end}Anchor`] === to.anchor;
    };
    if (!hasFreePoint) {
      const existing = Object.values(arrows).find((a) => fromKey(a, 'from') && toKey(a, 'to'));
      if (existing) return existing.id;
    }

    const id = 'a' + (nextId++) + '_' + Date.now().toString(36);
    const arrow = {
      id,
      fromNodeId:       from.nodeId        || null,
      fromAnchor:       from.anchor        || null,
      fromPillArrowId:  from.pillArrowId   || null,
      fromRegionId:     from.regionId      || null,
      fromPoint:        from.point         || null,
      toNodeId:         to.nodeId          || null,
      toAnchor:         to.anchor          || null,
      toPillArrowId:    to.pillArrowId     || null,
      toRegionId:       to.regionId        || null,
      toPoint:          to.point           || null,
      color: '#ffffff',
    };
    setStateWithHistory((prev) => ({
      ...prev,
      arrows: { ...prev.arrows, [id]: arrow },
    }));
    send({ type: 'arrow:add', arrow });
    setSelectedId(id);
    setSelectedType('arrow');
    return id;
  }, [arrows, setStateWithHistory, send]);

  const onUpdateArrow = useCallback((id, updates) => {
    setStateWithHistory((prev) => {
      const existing = prev.arrows[id];
      if (!existing) return prev;
      return { ...prev, arrows: { ...prev.arrows, [id]: { ...existing, ...updates } } };
    });
    send({ type: 'arrow:update', id, updates });
  }, [setStateWithHistory, send]);

  // Live arrow update WITHOUT pushing history — used during control-handle
  // dragging. A single history snapshot is committed on drag end (reuses
  // onNodeDragEnd, which snapshots whatever the current state is).
  const onUpdateArrowLive = useCallback((id, updates) => {
    setState((prev) => {
      const existing = prev.arrows[id];
      if (!existing) return prev;
      return { ...prev, arrows: { ...prev.arrows, [id]: { ...existing, ...updates } } };
    });
    send({ type: 'arrow:update', id, updates });
  }, [send]);

  // n-ary operator merge: when the user assigns kind = and / or / identical
  // to an arrow whose pill endpoint lands on a host arrow of the SAME kind,
  // the new arrow's other-side endpoint is folded into the host's
  // participants array and the new arrow is deleted. Returns the host id
  // on success, null otherwise.
  //
  // Visually: an existing A ∧ B group "absorbs" the new line so you end
  // up with one pill with three (or N) incoming participants, instead of
  // a chain of nested ∧ pills.
  const tryMergeIntoOperatorGroup = useCallback((arrowId, newKind) => {
    if (!MERGEABLE_KINDS.has(newKind)) return null;
    const a = stateRef.current.arrows[arrowId];
    if (!a) return null;
    // Figure out which end of the new arrow lands on a host pill.
    let hostId = null;
    let extEndpoint = null;
    if (a.toPillArrowId && !a.fromPillArrowId) {
      hostId = a.toPillArrowId;
      extEndpoint = { nodeId: a.fromNodeId || null, anchor: a.fromAnchor || null };
    } else if (a.fromPillArrowId && !a.toPillArrowId) {
      hostId = a.fromPillArrowId;
      extEndpoint = { nodeId: a.toNodeId || null, anchor: a.toAnchor || null };
    } else {
      // Both pill or neither pill: not a node↔pill connection, leave alone.
      return null;
    }
    if (!extEndpoint.nodeId) return null;
    const host = stateRef.current.arrows[hostId];
    if (!host) return null;
    if (host.kind !== newKind) return null;

    // Commit the merge.
    setStateWithHistory((prev) => {
      const hostNow = prev.arrows[hostId];
      const arrowNow = prev.arrows[arrowId];
      if (!hostNow || !arrowNow) return prev;
      const newParticipants = [...(hostNow.participants || []), extEndpoint];
      const newArrows = { ...prev.arrows };
      newArrows[hostId] = { ...hostNow, participants: newParticipants };
      delete newArrows[arrowId];
      return { ...prev, arrows: newArrows };
    });
    send({ type: 'arrow:update', id: hostId, updates: { participants: [...(host.participants || []), extEndpoint] } });
    send({ type: 'arrow:delete', id: arrowId });
    setSelectedId(hostId);
    setSelectedType('arrow');
    return hostId;
  }, [setStateWithHistory, send]);

  const onDeleteArrow = useCallback((id) => {
    setStateWithHistory((prev) => {
      const newArrows = { ...prev.arrows };
      // Cascade: any arrow whose endpoint references the deleted arrow's
      // pill is also dropped (otherwise it would dangle with no source/target).
      const queue = [id];
      const removed = new Set();
      while (queue.length) {
        const victim = queue.shift();
        if (removed.has(victim)) continue;
        removed.add(victim);
        delete newArrows[victim];
        for (const [aId, a] of Object.entries(newArrows)) {
          if (a.fromPillArrowId === victim || a.toPillArrowId === victim) {
            queue.push(aId);
          }
        }
      }
      // Mirror deletion to peers.
      for (const v of removed) send({ type: 'arrow:delete', id: v });
      return { ...prev, arrows: newArrows };
    });
    setSelectedId(null);
    setSelectedType(null);
  }, [setStateWithHistory, send]);

  // Several strokes as ONE undo step (a text highlight is one stroke per line).
  const onAddStrokes = useCallback((list) => {
    const made = (list || []).map((st) => ({ ...st, id: st.id || genId('s') }));
    if (!made.length) return;
    setStateWithHistory((prev) => {
      const have = new Set((prev.strokes || []).map((s) => s.id));
      const fresh = made.filter((s) => !have.has(s.id));
      return fresh.length ? { ...prev, strokes: [...(prev.strokes || []), ...fresh] } : prev;
    });
    for (const st of made) send({ type: 'stroke:add', stroke: st });
  }, [setStateWithHistory, send]);

  // Text highlights of the board, in reading order: [{ page, pdf, text }].
  const collectHighlights = useCallback(() => {
    const st = stateRef.current;
    const lay = layoutRef.current;
    const seen = new Map();
    for (const s of st.strokes || []) {
      if (!s.th || !s.text || !s.points || !s.points.length) continue;
      const y = s.points[0].y, x = s.points[0].x;
      const e = seen.get(s.th);
      if (!e) seen.set(s.th, { text: s.text, x, y });
      else if (y < e.y) { e.y = y; e.x = x; }
    }
    return [...seen.values()].sort((a, b) => a.y - b.y || a.x - b.x).map((e) => {
      const page = lay ? Math.min(lay.count - 1, pageOfY(lay, e.y)) : 0;
      return { page: page + 1, pdf: lay && lay.pages[page] ? lay.pages[page].bg || null : null, text: e.text };
    });
  }, []);

  // All text highlights → one Markdown note (the host decides where it goes).
  const exportHighlights = useCallback(async () => {
    const items = collectHighlights();
    if (!items.length) { setBusyNote('No text highlights yet'); setTimeout(() => setBusyNote(null), 1800); return; }
    const out = ['*Generated from the notebook — exporting again rewrites this note.*', ''];
    let last = null;
    for (const it of items) {
      const key = `${it.page}`;
      if (key !== last) {
        last = key;
        // A vault PDF gets a link that opens it on that page.
        const linkable = it.pdf && !/^(idb:|data:|blob:)/.test(it.pdf.src);
        out.push(linkable ? `## Page ${it.page} · [[${it.pdf.src}#page=${it.pdf.page}|${String(it.pdf.src).split('/').pop()} p. ${it.pdf.page}]]` : `## Page ${it.page}`, '');
      }
      out.push(`> ${it.text}`, '');
    }
    const md = out.join('\n');
    try {
      if (onSaveNote) {
        const where = await onSaveNote('highlights', md);
        setBusyNote(where ? `Saved ${where}` : 'Highlights saved');
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
        a.download = 'highlights.md';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        setBusyNote('Highlights downloaded');
      }
    } catch (e) { setBusyNote(`Could not save: ${(e && e.message) || e}`); }
    setTimeout(() => setBusyNote(null), 2400);
  }, [collectHighlights, onSaveNote]);

  // Words of the selected text highlights → clipboard.
  const copySelectedText = useCallback(() => {
    const ids = selection.strokeIds;
    const seen = new Set();
    const parts = [];
    for (const s of stateRef.current.strokes || []) {
      if (!ids.has(s.id) || !s.text || seen.has(s.th || s.id)) continue;
      seen.add(s.th || s.id); parts.push(s.text);
    }
    if (parts.length && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(parts.join('\n\n')).catch(() => {});
  }, [selection]);

  const onAddStroke = useCallback((stroke) => {
    const strokeWithId = { ...stroke, id: stroke.id || genId('s') };
    // Drop transient pen-gesture fields (hold-to-straighten bookkeeping).
    delete strokeWithId.t0; delete strokeWithId.straight;
    if (!strokeWithId.shape) delete strokeWithId.shape;
    setStateWithHistory((prev) => {
      // Guard against double-add (e.g. StrictMode double-invoke or a stray
      // second mouseup) which would create duplicate React keys.
      if ((prev.strokes || []).some((s) => s.id === strokeWithId.id)) return prev;
      return { ...prev, strokes: [...(prev.strokes || []), strokeWithId] };
    });
    send({ type: 'stroke:add', stroke: strokeWithId });
    if (TOUCH) setFnOpen(false); // writing: fold the corner toolbar away
  }, [setStateWithHistory, send]);

  // Region callbacks
  const onAddRegion = useCallback((region) => {
    setStateWithHistory((prev) => ({
      ...prev,
      regions: { ...(prev.regions || {}), [region.id]: region },
    }));
    send({ type: 'region:add', region });
  }, [setStateWithHistory, send]);

  const onUpdateRegion = useCallback((id, updates) => {
    setState((prev) => {
      const existing = (prev.regions || {})[id];
      if (!existing) return prev;
      return { ...prev, regions: { ...prev.regions, [id]: { ...existing, ...updates } } };
    });
    send({ type: 'region:update', id, updates });
  }, [send]);

  const onUpdateStroke = useCallback((id, updates) => {
    setState((prev) => ({
      ...prev,
      strokes: (prev.strokes || []).map(s => s.id === id ? { ...s, ...updates } : s),
    }));
    send({ type: 'stroke:update', id, updates });
  }, [send]);

  const onDeleteRegion = useCallback((id) => {
    setStateWithHistory((prev) => {
      const nr = { ...(prev.regions || {}) };
      delete nr[id];
      // Drop any arrows attached to this region (and transitively to their
      // dependent pill-attached arrows).
      const removed = new Set();
      const newArrows = { ...prev.arrows };
      for (const aId of Object.keys(newArrows)) {
        const a = newArrows[aId];
        if (a.fromRegionId === id || a.toRegionId === id) {
          delete newArrows[aId];
          removed.add(aId);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const aId of Object.keys(newArrows)) {
          const a = newArrows[aId];
          if ((a.fromPillArrowId && removed.has(a.fromPillArrowId)) ||
              (a.toPillArrowId   && removed.has(a.toPillArrowId))) {
            delete newArrows[aId];
            removed.add(aId);
            changed = true;
          }
        }
      }
      return { ...prev, regions: nr, arrows: newArrows };
    });
    send({ type: 'region:delete', id });
  }, [setStateWithHistory, send]);

  const onRegionDragEnd = useCallback(() => {
    setState(prev => { pushHistorySnapshot(prev); return prev; });
  }, [pushHistorySnapshot]);

  const onSelect = useCallback((id, type) => {
    setSelectedId(id);
    setSelectedType(type);
  }, []);

  // Shift-click: toggle an object into the multi-selection. Seeds the set with
  // the current single selection so shift-clicking a second object groups both.
  const onToggleSelect = useCallback((id, type) => {
    const key = SEL_KEY[type];
    if (!key) return;
    const next = {
      nodeIds: new Set(selection.nodeIds), arrowIds: new Set(selection.arrowIds),
      strokeIds: new Set(selection.strokeIds), regionIds: new Set(selection.regionIds || []),
    };
    const total = next.nodeIds.size + next.arrowIds.size + next.strokeIds.size + next.regionIds.size;
    if (total === 0 && selectedId && selectedType && SEL_KEY[selectedType]) {
      next[SEL_KEY[selectedType]].add(selectedId);
    }
    if (next[key].has(id)) next[key].delete(id); else next[key].add(id);
    setSelection(next);
    // Keep the single-object panel in sync when exactly one remains selected.
    const entries = [['node', next.nodeIds], ['arrow', next.arrowIds], ['region', next.regionIds], ['stroke', next.strokeIds]];
    const newTotal = entries.reduce((s, [, set]) => s + set.size, 0);
    if (newTotal === 1) {
      const only = entries.find(([, set]) => set.size === 1);
      setSelectedId([...only[1]][0]);
      setSelectedType(only[0]);
    } else {
      setSelectedId(null);
      setSelectedType(null);
    }
  }, [selection, selectedId, selectedType]);

  // Bulk edits over the current multi-selection.
  const bulkSelected = useCallback(() => {
    const out = [];
    for (const id of selection.nodeIds) if (state.nodes[id]) out.push({ id, type: 'node' });
    for (const id of (selection.regionIds || [])) if ((state.regions || {})[id]) out.push({ id, type: 'region' });
    for (const id of selection.arrowIds) if (state.arrows[id]) out.push({ id, type: 'arrow' });
    return out;
  }, [selection, state]);

  const bulkSetColor = useCallback((color) => {
    for (const { id, type } of bulkSelected()) {
      if (type === 'node') onUpdateNode(id, { color });
      else if (type === 'region') onUpdateRegion(id, { color });
      else if (type === 'arrow') {
        setState((prev) => ({ ...prev, arrows: { ...prev.arrows, [id]: { ...prev.arrows[id], color } } }));
        send({ type: 'arrow:update', id, updates: { color } });
      }
    }
    for (const id of selection.strokeIds) onUpdateStroke(id, { color });
    setState((prev) => { pushHistorySnapshot(prev); return prev; });
  }, [bulkSelected, onUpdateNode, onUpdateRegion, onUpdateStroke, selection, send, pushHistorySnapshot]);

  // Ink properties (width / opacity) over the selected strokes. `commit`
  // pushes one undo step — sliders call it on release.
  const bulkSetStroke = useCallback((updates, commit = true) => {
    for (const id of selection.strokeIds) onUpdateStroke(id, updates);
    if (commit) setState((prev) => { pushHistorySnapshot(prev); return prev; });
  }, [selection, onUpdateStroke, pushHistorySnapshot]);

  const bulkSetKind = useCallback((kind) => {
    for (const { id, type } of bulkSelected()) {
      if (type === 'node') onUpdateNode(id, { kind });
    }
    setState((prev) => { pushHistorySnapshot(prev); return prev; });
  }, [bulkSelected, onUpdateNode, pushHistorySnapshot]);

  /* ================================================================
     Eraser callbacks
     ================================================================ */
  // An erasing gesture fires these many times; they change state without an
  // undo step, and onEraseEnd records one for the whole gesture.
  const eraseDirtyRef = useRef(false);
  const onEraseObjects = useCallback((objectIds) => {
    if (!objectIds.nodeIds.length && !objectIds.arrowIds.length && !objectIds.strokeIds.length) return;
    eraseDirtyRef.current = true;
    send({ type: 'erase:objects', nodeIds: objectIds.nodeIds, arrowIds: objectIds.arrowIds, strokeIds: objectIds.strokeIds });
    setState((prev) => {
      const nodeIdSet = new Set(objectIds.nodeIds);
      const arrowIdSet = new Set(objectIds.arrowIds);
      const strokeIdSet = new Set(objectIds.strokeIds);

      // Remove nodes
      const newNodes = { ...prev.nodes };
      for (const id of nodeIdSet) delete newNodes[id];

      // Remove arrows (connected to deleted nodes, or explicitly erased)
      const newArrows = {};
      for (const [aId, arrow] of Object.entries(prev.arrows)) {
        if (arrowIdSet.has(aId)) continue;
        if (nodeIdSet.has(arrow.fromNodeId) || nodeIdSet.has(arrow.toNodeId)) continue;
        newArrows[aId] = arrow;
      }

      // Remove strokes
      const newStrokes = (prev.strokes || []).filter(s => !strokeIdSet.has(s.id));

      return { ...prev, nodes: newNodes, arrows: newArrows, strokes: newStrokes };
    });
  }, [send]);

  const onPixelErase = useCallback((newStrokes) => {
    eraseDirtyRef.current = true;
    setState((prev) => ({ ...prev, strokes: newStrokes }));
    send({ type: 'stroke:pixel-erase', newStrokes });
  }, [send]);

  const onEraseEnd = useCallback(() => {
    if (!eraseDirtyRef.current) return;
    eraseDirtyRef.current = false;
    setState((prev) => { pushHistorySnapshot(prev); return prev; });
    // "Auto": one erasing gesture, then back to the tool it interrupted.
    if (eraserAuto) setToolMode(lastToolRef.current && lastToolRef.current !== 'eraser' ? lastToolRef.current : 'draw');
  }, [pushHistorySnapshot, eraserAuto]);

  /* ================================================================
     Rectangle selection callbacks
     ================================================================ */
  const onSelectionChange = useCallback((sel) => {
    if (selectFilter === 'ink') setSelection({ ...sel, nodeIds: new Set(), arrowIds: new Set(), regionIds: new Set() });
    else if (selectFilter === 'objects') setSelection({ ...sel, strokeIds: new Set() });
    else setSelection(sel);
  }, [selectFilter]);

  const onDeleteSelection = useCallback(() => {
    const { nodeIds, arrowIds, strokeIds } = selection;
    const regionIds = selection.regionIds || new Set();
    if (nodeIds.size === 0 && arrowIds.size === 0 && strokeIds.size === 0 && regionIds.size === 0) return;

    // Compute the full cascade up front so the server gets the same set of
    // deletes as the local state. Without this group-delete updated only
    // React state — on refresh the server's init wiped the change and the
    // nodes/arrows came back.
    const removedArrows = new Set(arrowIds);
    for (const [aId, arrow] of Object.entries(arrows)) {
      if (removedArrows.has(aId)) continue;
      if (nodeIds.has(arrow.fromNodeId) || nodeIds.has(arrow.toNodeId)
          || regionIds.has(arrow.fromRegionId) || regionIds.has(arrow.toRegionId)) {
        removedArrows.add(aId);
      }
    }
    // Cascade through pill references: any arrow whose endpoint is a pill
    // of an already-removed arrow also has to go.
    let frontier = [...removedArrows];
    while (frontier.length) {
      const next = [];
      for (const [aId, arrow] of Object.entries(arrows)) {
        if (removedArrows.has(aId)) continue;
        if ((arrow.fromPillArrowId && removedArrows.has(arrow.fromPillArrowId)) ||
            (arrow.toPillArrowId   && removedArrows.has(arrow.toPillArrowId))) {
          removedArrows.add(aId);
          next.push(aId);
        }
      }
      frontier = next;
    }

    setStateWithHistory((prev) => {
      const newNodes = { ...prev.nodes };
      for (const id of nodeIds) delete newNodes[id];
      const newArrows = {};
      for (const [aId, arrow] of Object.entries(prev.arrows)) {
        if (!removedArrows.has(aId)) newArrows[aId] = arrow;
      }
      const newStrokes = (prev.strokes || []).filter(s => !strokeIds.has(s.id));
      const newRegions = { ...(prev.regions || {}) };
      for (const id of regionIds) delete newRegions[id];
      return { ...prev, nodes: newNodes, arrows: newArrows, strokes: newStrokes, regions: newRegions };
    });

    // Broadcast individual deletes so the server (and other clients) end
    // up in the same state. Order: arrows first (so server doesn't see
    // an arrow:delete referring to a node that's already been dropped —
    // not strictly required since server's applyDelta is tolerant, but
    // matches the local order).
    for (const id of removedArrows) send({ type: 'arrow:delete', id });
    for (const id of nodeIds)        send({ type: 'node:delete', id });
    for (const id of strokeIds)      send({ type: 'stroke:delete', id });
    for (const id of regionIds)      send({ type: 'region:delete', id });

    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
    setSelectedId(null);
    setSelectedType(null);
  }, [selection, arrows, setStateWithHistory, send]);

  // Move the selection (group drag). Called on every pointer move, so it only
  // touches local state; onSelectionDragEnd broadcasts the final positions —
  // without that the server keeps the old ones and a refresh reverts the move.
  const onMoveSelection = useCallback((dx, dy) => {
    setState(prev => {
      const newNodes = { ...prev.nodes };
      for (const id of selection.nodeIds) {
        if (newNodes[id]) newNodes[id] = { ...newNodes[id], x: newNodes[id].x + dx, y: newNodes[id].y + dy };
      }
      const newRegions = { ...(prev.regions || {}) };
      for (const id of (selection.regionIds || [])) {
        if (newRegions[id]) newRegions[id] = { ...newRegions[id], x: newRegions[id].x + dx, y: newRegions[id].y + dy };
      }
      const newStrokes = (prev.strokes || []).map(s => (
        selection.strokeIds.has(s.id) ? { ...s, points: s.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) } : s
      ));
      return { ...prev, nodes: newNodes, regions: newRegions, strokes: newStrokes };
    });
  }, [selection]);

  // Group drag / resize finished: one undo step, and one broadcast of where
  // everything ended up. The broadcast runs in an effect so it reads the state
  // committed together with the last move.
  const [selDragEnd, setSelDragEnd] = useState(0);
  const onSelectionDragEnd = useCallback(() => {
    setSelDragEnd((t) => t + 1);
    setState(prev => {
      pushHistorySnapshot(prev);
      return prev;
    });
  }, [pushHistorySnapshot]);
  useEffect(() => {
    if (!selDragEnd) return;
    for (const id of selection.nodeIds) {
      const n = state.nodes[id];
      if (n) send({ type: 'node:update', id, updates: { x: n.x, y: n.y, width: n.width, height: n.height } });
    }
    for (const id of (selection.regionIds || [])) {
      const r = (state.regions || {})[id];
      if (r) send({ type: 'region:update', id, updates: { x: r.x, y: r.y } });
    }
    for (const st of (state.strokes || [])) {
      if (selection.strokeIds.has(st.id)) send({ type: 'stroke:update', id: st.id, updates: { points: st.points, width: st.width } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDragEnd]);

  /* ================================================================
     Copy / cut / paste / duplicate — nodes, regions, ink, and every arrow
     whose ends are all inside the copied set.
     ================================================================ */
  const pasteCountRef = useRef(0);
  const effectiveSelection = useCallback(() => {
    const sel = {
      nodeIds: new Set(selection.nodeIds), arrowIds: new Set(selection.arrowIds),
      strokeIds: new Set(selection.strokeIds), regionIds: new Set(selection.regionIds || []),
    };
    if (selectedId && SEL_KEY[selectedType]) sel[SEL_KEY[selectedType]].add(selectedId);
    return sel;
  }, [selection, selectedId, selectedType]);

  const collectClip = useCallback((only = null) => {
    const st = stateRef.current;
    const sel = only || effectiveSelection();
    const cNodes = [...sel.nodeIds].map((id) => st.nodes[id]).filter(Boolean);
    const cRegions = [...sel.regionIds].map((id) => (st.regions || {})[id]).filter(Boolean);
    const cStrokes = (st.strokes || []).filter((x) => sel.strokeIds.has(x.id));
    const nodeSet = new Set(cNodes.map((n) => n.id));
    const regionSet = new Set(cRegions.map((r) => r.id));
    const arrowSet = new Set();
    const endsInside = (a) => {
      let any = false;
      for (const [id, set] of [[a.fromNodeId, nodeSet], [a.toNodeId, nodeSet], [a.fromRegionId, regionSet], [a.toRegionId, regionSet], [a.fromPillArrowId, arrowSet], [a.toPillArrowId, arrowSet]]) {
        if (!id) continue;
        any = true;
        if (!set.has(id)) return false;
      }
      for (const part of a.participants || []) if (part.nodeId && !nodeSet.has(part.nodeId)) return false;
      return any || sel.arrowIds.has(a.id); // free-floating arrows only when picked
    };
    for (let grew = true; grew;) {
      grew = false;
      for (const a of Object.values(st.arrows)) {
        if (!arrowSet.has(a.id) && endsInside(a)) { arrowSet.add(a.id); grew = true; }
      }
    }
    const cArrows = [...arrowSet].map((id) => st.arrows[id]);
    if (!cNodes.length && !cRegions.length && !cStrokes.length && !cArrows.length) return null;
    return JSON.parse(JSON.stringify({ catego: 1, nodes: cNodes, regions: cRegions, strokes: cStrokes, arrows: cArrows }));
  }, [effectiveSelection]);

  const copySelection = useCallback(() => {
    const clip = collectClip();
    if (!clip) return false;
    boardClipboard = clip;
    pasteCountRef.current = 0;
    try { navigator.clipboard?.writeText(JSON.stringify(clip))?.catch?.(() => {}); } catch { /* clipboard unavailable */ }
    return true;
  }, [collectClip]);

  const pasteClip = useCallback((clip, { inPlace = false } = {}) => {
    if (!clip || clip.catego !== 1) return false;
    const cNodes = clip.nodes || [], cRegions = clip.regions || [], cStrokes = clip.strokes || [], cArrows = clip.arrows || [];
    const cb = contentBounds({ nodes: cNodes, regions: cRegions, strokes: cStrokes, arrows: cArrows });
    if (!inPlace) pasteCountRef.current += 1;
    let dx = inPlace ? 0 : 40 * pasteCountRef.current, dy = dx;
    // The original isn't on screen (other board, scrolled away) → drop the
    // copy in the middle of the view instead of next to it.
    const el = rootRef.current;
    if (cb && el && !inPlace) {
      const m = (document.querySelector('.canvas-transform')?.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)\s*scale\(([^)]+)\)/);
      const vp = m ? { panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) } : stateRef.current.viewport;
      const vx0 = -vp.panX / vp.zoom, vy0 = -vp.panY / vp.zoom;
      const vx1 = vx0 + el.clientWidth / vp.zoom, vy1 = vy0 + el.clientHeight / vp.zoom;
      const onScreen = cb.x1 + dx > vx0 && cb.x0 + dx < vx1 && cb.y1 + dy > vy0 && cb.y0 + dy < vy1;
      if (!onScreen) {
        const snap20 = (v) => Math.round(v / 20) * 20;
        dx = snap20((vx0 + vx1) / 2 - (cb.x0 + cb.x1) / 2);
        dy = snap20((vy0 + vy1) / 2 - (cb.y0 + cb.y1) / 2);
      }
    }
    const idMap = {};
    const newNodes = cNodes.map((n) => { const id = genId(); idMap[n.id] = id; return { ...n, id, x: n.x + dx, y: n.y + dy }; });
    const newRegions = cRegions.map((r) => { const id = genId('r'); idMap[r.id] = id; return { ...r, id, x: r.x + dx, y: r.y + dy }; });
    const newStrokes = cStrokes.map((x) => ({ ...x, id: genId('s'), points: (x.points || []).map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy })) }));
    for (const a of cArrows) idMap[a.id] = genId('a');
    const mapId = (id) => (id ? (idMap[id] || null) : id);
    const movePt = (pt) => (pt ? { ...pt, x: pt.x + dx, y: pt.y + dy } : pt);
    const newArrows = cArrows.map((a) => ({
      ...a, id: idMap[a.id],
      fromNodeId: mapId(a.fromNodeId), toNodeId: mapId(a.toNodeId),
      fromRegionId: mapId(a.fromRegionId), toRegionId: mapId(a.toRegionId),
      fromPillArrowId: mapId(a.fromPillArrowId), toPillArrowId: mapId(a.toPillArrowId),
      fromPoint: movePt(a.fromPoint), toPoint: movePt(a.toPoint),
      ...(a.participants ? { participants: a.participants.map((part) => ({ ...part, nodeId: mapId(part.nodeId) })) } : {}),
    }));
    setStateWithHistory((prev) => ({
      ...prev,
      nodes: { ...prev.nodes, ...Object.fromEntries(newNodes.map((n) => [n.id, n])) },
      regions: { ...(prev.regions || {}), ...Object.fromEntries(newRegions.map((r) => [r.id, r])) },
      arrows: { ...prev.arrows, ...Object.fromEntries(newArrows.map((a) => [a.id, a])) },
      strokes: [...(prev.strokes || []), ...newStrokes],
    }));
    for (const n of newNodes) send({ type: 'node:add', node: n });
    for (const r of newRegions) send({ type: 'region:add', region: r });
    for (const a of newArrows) send({ type: 'arrow:add', arrow: a });
    for (const x of newStrokes) send({ type: 'stroke:add', stroke: x });
    // The copy becomes the selection, ready to be moved.
    setToolMode('select');
    setSelectedId(null);
    setSelectedType(null);
    setSelection({
      nodeIds: new Set(newNodes.map((n) => n.id)), arrowIds: new Set(newArrows.map((a) => a.id)),
      strokeIds: new Set(newStrokes.map((x) => x.id)), regionIds: new Set(newRegions.map((r) => r.id)),
    });
    return true;
  }, [setStateWithHistory, send]);

  const addImageBlobRef = useRef(null);
  const pasteFromClipboard = useCallback(() => {
    // A picture on the system clipboard (screenshot, copied image) wins: it is
    // the newest thing copied. No picture / no permission → the board buffer.
    const viaBoard = () => {
      if (boardClipboard) { pasteClip(boardClipboard); return true; }
      return false;
    };
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        navigator.clipboard.read().then(async (items) => {
          for (const it of items) {
            const type = (it.types || []).find((t) => t.startsWith('image/'));
            if (type) { const blob = await it.getType(type); if (addImageBlobRef.current) addImageBlobRef.current(blob, 'pasted.png'); return; }
          }
          if (viaBoard()) return;
          for (const it of items) {
            if (!(it.types || []).includes('text/plain')) continue;
            const text = await (await it.getType('text/plain')).text();
            try { const clip = JSON.parse(text); if (clip && clip.catego === 1) { boardClipboard = clip; pasteClip(clip); } } catch { /* not a board */ }
            return;
          }
        }).catch(() => { viaBoard(); });
        return;
      }
    } catch { /* fall through */ }
    if (viaBoard()) return;
    // Nothing copied in this window — maybe another window / tab did.
    try {
      navigator.clipboard?.readText?.().then((text) => {
        try { const clip = JSON.parse(text); if (clip && clip.catego === 1) { boardClipboard = clip; pasteClip(clip); } } catch { /* not a board */ }
      }).catch(() => {});
    } catch { /* clipboard unavailable */ }
  }, [pasteClip]);

  // Delete whatever is selected — a group, or the single selected object.
  // (Touch screens have no Delete key; this is what the trash buttons call.)
  const deleteAnySelection = useCallback(() => {
    const groupSize = selection.nodeIds.size + selection.arrowIds.size + selection.strokeIds.size + (selection.regionIds ? selection.regionIds.size : 0);
    if (groupSize > 0) { onDeleteSelection(); return; }
    if (!selectedId) return;
    if (selectedType === 'node') onDeleteNode(selectedId);
    else if (selectedType === 'arrow') onDeleteArrow(selectedId);
    else if (selectedType === 'region') { onDeleteRegion(selectedId); setSelectedId(null); setSelectedType(null); }
  }, [selection, selectedId, selectedType, onDeleteSelection, onDeleteNode, onDeleteArrow, onDeleteRegion]);

  // Alt-drag (Canvas): copy the object — or the whole selection it is part
  // of — exactly where it is, and select the copies; the drag moves them.
  const onAltDuplicate = useCallback((type, id) => {
    const key = SEL_KEY[type];
    const inGroup = key && selection[key] && selection[key].has(id);
    const only = inGroup ? null : {
      nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set(), regionIds: new Set(), [key]: new Set([id]),
    };
    const clip = collectClip(only);
    if (clip) pasteClip(clip, { inPlace: true });
  }, [selection, collectClip, pasteClip]);

  // Lasso finished: with something caught, hand over to the Select tool so
  // the catch can be moved, resized, recoloured or deleted.
  const onLassoEnd = useCallback(() => {}, []);

  const duplicateSelection = useCallback(() => {
    const clip = collectClip();
    if (!clip) return;
    pasteCountRef.current = 0;
    pasteClip(clip);
  }, [collectClip, pasteClip]);


  /* ================================================================
     Whole-board edits (page operations, add space, agent inbox): one undo
     step, broadcast as a full snapshot — the same message undo uses.
     ================================================================ */
  const commitBulk = useCallback((fn) => {
    const prev = stateRef.current;
    const res = fn(prev);
    if (!res) return false;
    const patch = { nodes: res.nodes, arrows: res.arrows, regions: res.regions, strokes: res.strokes, doc: res.doc !== undefined ? res.doc : prev.doc };
    const next = { ...prev, ...patch };
    stateRef.current = next;
    setState((cur) => ({ ...cur, ...patch }));
    pushHistorySnapshot(next);
    send({ type: 'state:undo', state: takeSnapshot(next) });
    if (patch.doc !== prev.doc) send({ type: 'doc:update', doc: patch.doc });
    setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set(), regionIds: new Set() });
    setSelectedId(null); setSelectedType(null);
    return next;
  }, [pushHistorySnapshot, send]);

  // World point in the middle of the view (read from the DOM: a pan in
  // progress hasn't reached React state yet).
  const viewCentre = useCallback(() => {
    const el = rootRef.current;
    const tr = el && el.querySelector('.canvas-transform');
    const m = tr && (tr.style.transform || '').match(/translate\(([^,]+)px,\s*([^)]+)px\)\s*scale\(([^)]+)\)/);
    const vp = m ? { panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) } : stateRef.current.viewport;
    const w = el ? el.clientWidth : window.innerWidth, h = el ? el.clientHeight : window.innerHeight;
    return { x: (w / 2 - vp.panX) / vp.zoom, y: (h / 2 - vp.panY) / vp.zoom, vp, w, h };
  }, []);

  // Page under the middle of the view.
  const currentPage = layout
    ? pageIndexAt(layout, ((rootRef.current ? rootRef.current.clientHeight : 800) / 2 - viewport.panY) / viewport.zoom)
    : 0;
  const goToPage = useCallback((i) => {
    const lay = layoutRef.current;
    if (lay) fitPage(Math.max(0, Math.min(lay.count - 1, i)), lay);
  }, [fitPage]);
  // After a page operation: show page i of the NEW layout (derived from the
  // state the operation produced).
  const afterPageOp = useCallback((next, i) => {
    if (next && next.doc) fitPage(i, computeDocLayout(next.doc, next));
  }, [fitPage]);
  const onInsertPage = useCallback((i) => { afterPageOp(commitBulk((st) => insertPage(st, i)), i); }, [commitBulk, afterPageOp]);
  const onDeletePage = useCallback((i) => { afterPageOp(commitBulk((st) => deletePage(st, i)), Math.max(0, i - 1)); }, [commitBulk, afterPageOp]);
  const onMovePage = useCallback((from, to) => { if (to >= 0) afterPageOp(commitBulk((st) => movePage(st, from, to)), to); }, [commitBulk, afterPageOp]);
  const onDuplicatePage = useCallback((i) => { afterPageOp(commitBulk((st) => duplicatePage(st, i, genId)), i + 1); }, [commitBulk, afterPageOp]);
  // "Add space" tool: push everything below a line down (or pull it up).
  const onAddSpace = useCallback((y0, dy) => { commitBulk((st) => shiftBelow(st, y0, dy)); }, [commitBulk]);

  /* ================================================================
     Pictures and PDFs
     ================================================================ */
  const [busyNote, setBusyNote] = useState(null); // "Importing…" banner
  const fileInputRef = useRef(null);

  // Put a picture on the board: `src` is an asset reference (or a data URL).
  const placeImage = useCallback((src, natW, natH, at = null) => {
    const c = viewCentre();
    const sn = (v) => Math.round(v / 20) * 20;
    const maxW = Math.min(600, Math.max(120, (c.w / c.vp.zoom) * 0.6));
    const width = Math.max(40, sn(Math.min(natW || 320, maxW)));
    const height = Math.max(20, Math.round((width * (natH || 240)) / (natW || 320)));
    const id = genId();
    const node = { id, shape: 'image', image: src, x: sn((at ? at.x : c.x) - width / 2), y: sn((at ? at.y : c.y) - height / 2), width, height, text: '', color: '#ffffff' };
    setStateWithHistory((prev) => ({ ...prev, nodes: { ...prev.nodes, [id]: node } }));
    send({ type: 'node:add', node });
    setToolMode('select');
    setSelectedId(id); setSelectedType('node');
  }, [viewCentre, setStateWithHistory, send]);

  const addImageBlob = useCallback(async (blob, name = 'image.png', at = null) => {
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('Not an image')); im.src = objUrl; });
      const natW = img.naturalWidth || 320, natH = img.naturalHeight || 240;
      let src;
      if (assets && assets.save) src = await assets.save(blob, name);
      else {
        // No asset store: keep the picture inside the board, downscaled.
        const k = Math.min(1, IMAGE_MAX_EMBED / Math.max(natW, natH));
        const cv = document.createElement('canvas');
        cv.width = Math.round(natW * k); cv.height = Math.round(natH * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        src = cv.toDataURL(/png/i.test(blob.type) && blob.size < 400000 ? 'image/png' : 'image/jpeg', 0.85);
      }
      placeImage(src, natW, natH, at);
    } catch (e) {
      alert('Could not add the picture: ' + ((e && e.message) || e));
    } finally { URL.revokeObjectURL(objUrl); }
  }, [assets, placeImage]);

  // A PDF already stored as an asset → one sheet per page, appended after the
  // last used sheet (a board that isn't a document yet becomes one, sized to
  // the PDF's first page).
  const importPdfSrc = useCallback(async (src) => {
    if (!pdf) { alert('PDF import is not available here.'); return; }
    setBusyNote('Importing PDF…');
    try {
      const sizes = await pdf.pageSizes(src);
      if (!sizes.length) throw new Error('The PDF has no pages');
      let start = 0;
      const ok = commitBulk((st) => {
        let doc = st.doc;
        const blank = !doc || (!contentBounds(st) && !doc.bgs);
        if (blank) {
          const cb = contentBounds(st);
          const down = (v) => Math.floor(v / 20) * 20;
          const w = 820, h = Math.max(200, Math.round((w * sizes[0].h) / sizes[0].w / 20) * 20);
          doc = { ...makeDoc('a4', 'blank', !doc && cb ? { x: down(cb.x0 - 40), y: down(cb.y0 - 40) } : (doc ? { x: doc.x, y: doc.y } : null)), w, h, paper: 'a4' };
        }
        const lay = computeDocLayout(doc, st);
        start = blank && !contentBounds(st) ? 0 : lay.count - 1;
        const bgs = { ...(doc.bgs || {}) };
        sizes.forEach((_, i) => { bgs[start + i] = { src, page: i + 1 }; });
        return { nodes: st.nodes, arrows: st.arrows, regions: st.regions || {}, strokes: st.strokes || [], doc: { ...doc, bgs } };
      });
      if (ok) { setPagesOpen(true); afterPageOp(ok, start); }
    } catch (e) {
      alert('Could not import the PDF: ' + ((e && e.message) || e));
    } finally { setBusyNote(null); }
  }, [pdf, commitBulk, afterPageOp]);

  const addFiles = useCallback(async (files, at = null) => {
    for (const f of files) {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')) {
        if (!assets || !assets.save || !pdf) { alert('PDF import is not available here.'); continue; }
        setBusyNote('Importing PDF…');
        let src = null;
        try { src = await assets.save(f, f.name || 'document.pdf'); } catch (e) { alert('Could not store the PDF: ' + ((e && e.message) || e)); }
        setBusyNote(null);
        if (src) await importPdfSrc(src);
      } else if ((f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|heic|bmp)$/i.test(f.name || '')) {
        await addImageBlob(f, f.name || 'image.png', at);
      }
    }
  }, [assets, pdf, importPdfSrc, addImageBlob]);
  const pickFiles = useCallback((accept) => {
    const el = fileInputRef.current;
    if (!el) return;
    el.accept = accept;
    el.value = '';
    el.click();
  }, []);

  useEffect(() => { addImageBlobRef.current = addImageBlob; });

  // Files dragged from the desktop onto the board.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const over = (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    const drop = (e) => {
      if (!hasFiles(e) || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const c = viewCentre();
      addFiles(Array.from(e.dataTransfer.files), { x: (e.clientX - rect.left - c.vp.panX) / c.vp.zoom, y: (e.clientY - rect.top - c.vp.panY) / c.vp.zoom });
    };
    root.addEventListener('dragover', over);
    root.addEventListener('drop', drop);
    return () => { root.removeEventListener('dragover', over); root.removeEventListener('drop', drop); };
  }, [addFiles, viewCentre]);

  // Host bridge: files that already live in the host's store (vault), and
  // the agent inbox (src/agentOps.js).
  useEffect(() => {
    if (!bridge) return;
    bridge.importPdfSrc = importPdfSrc;
    bridge.addImageSrc = (src, clientX, clientY) => {
      const root = rootRef.current;
      const rect = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
      const c = viewCentre();
      const at = clientX != null ? { x: (clientX - rect.left - c.vp.panX) / c.vp.zoom, y: (clientY - rect.top - c.vp.panY) / c.vp.zoom } : null;
      Promise.resolve(assets && assets.url ? assets.url(src) : src).then((url) => new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => resolve([320, 240]);
        im.src = url;
      })).then(([w, h]) => placeImage(src, w, h, at));
    };
    bridge.applyAgentOps = (ops, done) => {
      let applied = [];
      commitBulk((st) => {
        const res = applyAgentOps(st, ops, done);
        applied = res.applied;
        return res.changed ? res.state : null;
      });
      return applied;
    };
  });

  /* ================================================================
     Vim-mode: Tab toggle + WASD nudge
     ================================================================ */
  // Find the node closest to the centre of the viewport (in world coords)
  // — used as the default target when entering edit mode without a recent
  // edit to fall back to.
  const findCenterNode = useCallback(() => {
    const sw = window.innerWidth, sh = window.innerHeight;
    const cx = (sw / 2 - viewport.panX) / viewport.zoom;
    const cy = (sh / 2 - viewport.panY) / viewport.zoom;
    let bestId = null, bestD = Infinity;
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      const ncx = n.x + (n.width || 220) / 2;
      const ncy = n.y + (n.height || 60) / 2;
      const d = (ncx - cx) ** 2 + (ncy - cy) ** 2;
      if (d < bestD) { bestD = d; bestId = id; }
    }
    return bestId;
  }, [nodes, viewport]);

  // Enter toggles dev <-> edit. Capture-phase listener so the contentEditable
  // node doesn't swallow Enter (which by default inserts a newline) in
  // edit mode. Shift+Enter is left alone — that's still "newline" inside
  // a node's text.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Enter') return;
      const meta = e.metaKey || e.ctrlKey;
      if (mode === 'edit') {
        // Cmd/Ctrl+Enter → newline; Alt+Enter → new list item; plain Enter → exit to dev.
        if (meta) { e.preventDefault(); e.stopPropagation(); document.execCommand('insertLineBreak'); return; }
        if (e.altKey) { e.preventDefault(); e.stopPropagation(); insertListItemAtCaret(); return; }
        if (e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        if (editingNodeId) {
          lastEditedRef.current = editingNodeId;
          setSelectedId(editingNodeId);
          setSelectedType('node');
        }
        setEditingNodeId(null);
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        setMode('dev');
        return;
      }
      if (meta || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      let target = (selectedType === 'node' && selectedId && nodes[selectedId]) ? selectedId : null;
      if (!target) target = (lastEditedRef.current && nodes[lastEditedRef.current]) ? lastEditedRef.current : null;
      if (!target) target = findCenterNode();
      if (!target) return;
      setSelectedId(target);
      setSelectedType('node');
      setEditingNodeId(target);
      setMode('edit');
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, editingNodeId, nodes, findCenterNode, selectedId, selectedType]);

  // Absorb Tab in edit mode so it doesn't move focus off the contentEditable
  // span (browser default for Tab). Tab navigation lives in dev mode only.
  useEffect(() => {
    if (mode !== 'edit') return;
    function onKey(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  // I/J/K/L starts a keyboard arrow-drag from a side of the selected node;
  // while held, WASD moves a virtual cursor (same step as node-nudge),
  // release drops the arrow (snap to nearest node anchor or spawn a new
  // grid-aligned node if no snap and the cursor moved enough).
  const [kbArrowDrag, setKbArrowDrag] = useState(null);
  const kbArrowDragRef = useRef(null);
  useEffect(() => { kbArrowDragRef.current = kbArrowDrag; }, [kbArrowDrag]);
  const heldArrowKeyRef = useRef(null); // 'KeyI' | 'KeyJ' | 'KeyK' | 'KeyL' | null
  // Tab-as-modifier: held = directional nav with WASD; tap (down + up
  // without WASD pressed in between) = row-major step through visible nodes.
  const tabHeldRef = useRef(false);
  const tabConsumedRef = useRef(false);
  // Same idea but for arrow navigation: `>` is to arrows what Tab is to nodes.
  const gtHeldRef = useRef(false);
  const gtConsumedRef = useRef(false);
  // Continuous-nudge state lives at component-level so it survives effect
  // re-runs (otherwise mid-press state changes would clear `dirs` and
  // `interval`, breaking the held-key continuous motion).
  const wasdDirsRef = useRef(new Set());
  const wasdRafRef = useRef(0);
  const wasdLastFrameTimeRef = useRef(0);
  // Zoom (held +/- /=) — RAF-driven smooth multiply, no OS keyrepeat pause.
  const zoomKeysRef = useRef(new Set()); // 'in' | 'out'
  const zoomRafRef = useRef(0);
  const zoomLastFrameTimeRef = useRef(0);
  // Canvas exposes its imperative nudge API here; called every WASD tick
  // so we update DOM directly (no React re-render per tick).
  const kbNudgeApiRef = useRef({});
  // Mirror the values the keyboard effect needs into refs so the effect
  // can mount once per mode change instead of restarting on every state
  // update (which would tear down listeners and cancel the interval).
  const selectedIdRef = useRef(selectedId);
  const selectedTypeRef = useRef(selectedType);
  const viewportRef = useRef(viewport);
  const onUpdateNodeRef = useRef(onUpdateNode);
  const onAddNodeRef = useRef(onAddNode);
  const onAddArrowRef = useRef(onAddArrow);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectedTypeRef.current = selectedType; }, [selectedType]);
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);
  useEffect(() => { onUpdateNodeRef.current = onUpdateNode; }, [onUpdateNode]);
  useEffect(() => { onAddNodeRef.current = onAddNode; }, [onAddNode]);
  useEffect(() => { onAddArrowRef.current = onAddArrow; }, [onAddArrow]);
  const onDeleteNodeRef = useRef(onDeleteNode);
  const onDeleteArrowRef = useRef(onDeleteArrow);
  const onUpdateViewportRef = useRef(onUpdateViewport);
  const onUpdateArrowRef = useRef(onUpdateArrow);
  useEffect(() => { onDeleteNodeRef.current = onDeleteNode; }, [onDeleteNode]);
  useEffect(() => { onDeleteArrowRef.current = onDeleteArrow; }, [onDeleteArrow]);
  useEffect(() => { onUpdateViewportRef.current = onUpdateViewport; }, [onUpdateViewport]);
  useEffect(() => { onUpdateArrowRef.current = onUpdateArrow; }, [onUpdateArrow]);
  const tryMergeIntoOperatorGroupRef = useRef(tryMergeIntoOperatorGroup);
  useEffect(() => { tryMergeIntoOperatorGroupRef.current = tryMergeIntoOperatorGroup; }, [tryMergeIntoOperatorGroup]);
  const onUpdateRegionRef = useRef(onUpdateRegion);
  useEffect(() => { onUpdateRegionRef.current = onUpdateRegion; }, [onUpdateRegion]);
  // Timestamp of the last Shift+P (presupposes) — a following Shift+− / Shift+=
  // within the window turns the arrow into a probability shifter instead.
  const probChordRef = useRef(0);

  // Combined WASD + I/J/K/L + Tab handler in dev mode for the selected node.
  // Mounts ONCE per dev/edit transition; reads dynamic data via refs to
  // avoid restarting (which would clear `dirs` mid-press and break the
  // continuous-while-held WASD motion).
  useEffect(() => {
    if (mode !== 'dev') return;

    const GRID = 20;
    const SNAP_DIST_SQ = 30 * 30;
    const ANCHOR_OF = { KeyI: 'top', KeyJ: 'left', KeyK: 'bottom', KeyL: 'right' };
    // Tracks whether WASD was pressed during an I/J/K/L hold. If not, the
    // tap is interpreted as "spawn a child node 4 grid cells away in that
    // direction" instead of starting a manual cursor drag.
    const kbArrowConsumedRef = { current: false };

    function getNodeAnchorPos(n, anchor) {
      const w = n.width || 220;
      const h = n.height || 60;
      switch (anchor) {
        case 'top':    return { x: n.x + w / 2, y: n.y };
        case 'right':  return { x: n.x + w,     y: n.y + h / 2 };
        case 'bottom': return { x: n.x + w / 2, y: n.y + h };
        case 'left':   return { x: n.x,         y: n.y + h / 2 };
      }
      return null;
    }

    function findSnap(wx, wy, excludeId) {
      const all = stateRef.current.nodes;
      let best = null, bestD = Infinity;
      for (const id of Object.keys(all)) {
        if (id === excludeId) continue;
        const n = all[id];
        for (const a of ['top', 'right', 'bottom', 'left']) {
          const p = getNodeAnchorPos(n, a);
          const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
          if (d < bestD) { bestD = d; best = { nodeId: id, anchor: a }; }
        }
      }
      return (best && bestD <= SNAP_DIST_SQ) ? best : null;
    }

    function startKbArrowDrag(anchor) {
      const sid = selectedIdRef.current;
      const stype = selectedTypeRef.current;
      if (!sid) return;

      if (stype === 'node') {
        const node = stateRef.current.nodes[sid];
        if (!node) return;
        const p = getNodeAnchorPos(node, anchor);
        setKbArrowDrag({
          sourceNodeId: sid, sourceAnchor: anchor,
          originX: p.x, originY: p.y,
          cursorX: p.x, cursorY: p.y,
          snapNodeId: null, snapAnchor: null,
        });
      } else if (stype === 'arrow') {
        // Arrow selected → drag from its midpoint pill (only typed arrows
        // have a pill).
        const a = stateRef.current.arrows[sid];
        if (!a || !a.kind) return;
        const mid = arrowApproxMid(a);
        if (!mid) return;
        const isOperator = ['and', 'or', 'consequently', 'equivalently'].includes(a.kind);
        const halfW = isOperator ? 13 : 10;
        const halfH = isOperator ? 10 : 10;
        let ax = mid.x, ay = mid.y;
        if (anchor === 'top')         ay -= halfH;
        else if (anchor === 'bottom') ay += halfH;
        else if (anchor === 'left')   ax -= halfW;
        else if (anchor === 'right')  ax += halfW;
        setKbArrowDrag({
          sourcePillArrowId: sid, sourceAnchor: anchor,
          originX: ax, originY: ay,
          cursorX: ax, cursorY: ay,
          snapNodeId: null, snapAnchor: null,
        });
      }
    }

    function moveKbArrowCursor(dx, dy) {
      const prev = kbArrowDragRef.current;
      if (!prev) return;
      kbArrowConsumedRef.current = true; // user is steering with WASD
      const newX = prev.cursorX + dx;
      const newY = prev.cursorY + dy;
      // Don't snap to the source node when source is a node; pass null
      // when source is a pill (no node to exclude).
      const snap = findSnap(newX, newY, prev.sourceNodeId || null);
      setKbArrowDrag({
        ...prev,
        cursorX: newX, cursorY: newY,
        snapNodeId: snap ? snap.nodeId : null,
        snapAnchor: snap ? snap.anchor : null,
      });
    }

    function endKbArrowDrag() {
      const prev = kbArrowDragRef.current;
      setKbArrowDrag(null);
      const consumed = kbArrowConsumedRef.current;
      kbArrowConsumedRef.current = false;
      if (!prev) return;
      const addArrow = onAddArrowRef.current;
      const addNode = onAddNodeRef.current;

      // Build the source endpoint (node-anchor or pill-anchor).
      const fromEndpoint = prev.sourcePillArrowId
        ? { pillArrowId: prev.sourcePillArrowId, anchor: prev.sourceAnchor }
        : { nodeId: prev.sourceNodeId,           anchor: prev.sourceAnchor };

      // Snap to existing node anchor (cursor reached it).
      if (prev.snapNodeId && prev.snapAnchor) {
        addArrow(fromEndpoint, { nodeId: prev.snapNodeId, anchor: prev.snapAnchor });
        return;
      }

      
      // Quick-spawn: bare I/J/K/L tap (no WASD during hold) →
      // spawn a child node 4 grid cells away from the source anchor.
      if (!consumed) {
        const QUICK_GAP = 4 * GRID; // 80px
        const ox = prev.originX, oy = prev.originY;
        let nx, ny, toAnchor;
        switch (prev.sourceAnchor) {
          case 'top':
            nx = ox - NEW_W / 2;
            ny = oy - QUICK_GAP - NEW_H;
            toAnchor = 'bottom';
            break;
          case 'bottom':
            nx = ox - NEW_W / 2;
            ny = oy + QUICK_GAP;
            toAnchor = 'top';
            break;
          case 'left':
            nx = ox - QUICK_GAP - NEW_W;
            ny = oy - NEW_H / 2;
            toAnchor = 'right';
            break;
          case 'right':
          default:
            nx = ox + QUICK_GAP;
            ny = oy - NEW_H / 2;
            toAnchor = 'left';
            break;
        }
        nx = Math.round(nx / GRID) * GRID;
        ny = Math.round(ny / GRID) * GRID;
        const newId = addNode(nx, ny);
        if (newId) {
          addArrow(fromEndpoint, { nodeId: newId, anchor: toAnchor });
          setSelectedId(newId);
          setSelectedType('node');
          // Drop straight into edit mode so you can type the node's text.
          lastEditedRef.current = newId;
          setEditingNodeId(newId);
          setMode('edit');
        }
        return;
      }

      // User steered with WASD → spawn at the cursor (free placement).
      const dx = prev.cursorX - prev.originX;
      const dy = prev.cursorY - prev.originY;
      if (Math.hypot(dx, dy) < 24) return;
      const toAnchor = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? 'left' : 'right')
        : (dy > 0 ? 'top' : 'bottom');
      let nx, ny;
      if (toAnchor === 'left')        { nx = prev.cursorX;             ny = prev.cursorY - NEW_H / 2; }
      else if (toAnchor === 'right')  { nx = prev.cursorX - NEW_W;     ny = prev.cursorY - NEW_H / 2; }
      else if (toAnchor === 'top')    { nx = prev.cursorX - NEW_W / 2; ny = prev.cursorY; }
      else                            { nx = prev.cursorX - NEW_W / 2; ny = prev.cursorY - NEW_H; }
      nx = Math.round(nx / GRID) * GRID;
      ny = Math.round(ny / GRID) * GRID;
      const newId = addNode(nx, ny);
      if (newId) {
        addArrow(fromEndpoint, { nodeId: newId, anchor: toAnchor });
        setSelectedId(newId);
        setSelectedType('node');
        lastEditedRef.current = newId;
        setEditingNodeId(newId);
        setMode('edit');
      }
    }

    // ---- Tab navigation helpers ------------------------------------
    function isVisible(n) {
      const vp = viewportRef.current;
      const w = n.width || 220, h = n.height || 60;
      const sx = n.x * vp.zoom + vp.panX;
      const sy = n.y * vp.zoom + vp.panY;
      return sx + w * vp.zoom > 0 && sx < window.innerWidth &&
             sy + h * vp.zoom > 0 && sy < window.innerHeight;
    }
    function getVisibleNodes() {
      const all = stateRef.current.nodes;
      const r = [];
      for (const id of Object.keys(all)) {
        const n = all[id];
        if (isVisible(n)) r.push(n);
      }
      return r;
    }
    function navigateRowMajor() {
      const visible = getVisibleNodes();
      if (visible.length === 0) return;
      const ROW_TOL = 30;
      visible.sort((a, b) => {
        if (Math.abs(a.y - b.y) > ROW_TOL) return a.y - b.y;
        return a.x - b.x;
      });
      const sid = selectedIdRef.current;
      const curIdx = sid ? visible.findIndex(n => n.id === sid) : -1;
      const nextIdx = (curIdx + 1) % visible.length;
      setSelectedId(visible[nextIdx].id);
      setSelectedType('node');
    }
    function counterOf(id) {
      const m = id ? id.match(/^[na](\d+)/) : null;
      return m ? parseInt(m[1], 10) : -1;
    }
    function distSq(ax, ay, bx, by) {
      return (ax - bx) ** 2 + (ay - by) ** 2;
    }
    function pickReplacementAfterDelete(deletedId, kind /* 'node' | 'arrow' */) {
      const all = kind === 'node' ? stateRef.current.nodes : stateRef.current.arrows;
      const ids = Object.keys(all).filter(id => id !== deletedId);
      if (ids.length === 0) return null;
      // Prefer the most recent item created BEFORE the deleted one.
      const targetCounter = counterOf(deletedId);
      let prevId = null, prevCounter = -1;
      for (const id of ids) {
        const c = counterOf(id);
        if (c < targetCounter && c > prevCounter) { prevCounter = c; prevId = id; }
      }
      if (prevId) return prevId;
      // Fallback: spatially nearest. For arrows we use approx-midpoint.
      if (kind === 'node') {
        const cur = stateRef.current.nodes[deletedId];
        if (!cur) return ids[0];
        const cx = cur.x + (cur.width || 220) / 2;
        const cy = cur.y + (cur.height || 60) / 2;
        let best = null, bestD = Infinity;
        for (const id of ids) {
          const n = all[id];
          const ncx = n.x + (n.width || 220) / 2;
          const ncy = n.y + (n.height || 60) / 2;
          const d = distSq(cx, cy, ncx, ncy);
          if (d < bestD) { bestD = d; best = id; }
        }
        return best;
      } else {
        const mid = arrowApproxMid(stateRef.current.arrows[deletedId]);
        if (!mid) return ids[0];
        let best = null, bestD = Infinity;
        for (const id of ids) {
          const m = arrowApproxMid(all[id]);
          if (!m) continue;
          const d = distSq(mid.x, mid.y, m.x, m.y);
          if (d < bestD) { bestD = d; best = id; }
        }
        return best;
      }
    }
    function arrowApproxMid(a) {
      if (!a) return null;
      const allNodes = stateRef.current.nodes;
      const allArrows = stateRef.current.arrows;
      function pos(arrow, end, depth = 0) {
        if (depth > 8) return null;
        const pillId = end === 'from' ? arrow.fromPillArrowId : arrow.toPillArrowId;
        if (pillId) {
          const host = allArrows[pillId];
          if (!host) return null;
          const f = pos(host, 'from', depth + 1);
          const t = pos(host, 'to',   depth + 1);
          if (!f || !t) return null;
          return { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };
        }
        const nid = end === 'from' ? arrow.fromNodeId : arrow.toNodeId;
        const an  = end === 'from' ? arrow.fromAnchor : arrow.toAnchor;
        const n = allNodes[nid];
        if (!n) return null;
        return getNodeAnchorPos(n, an);
      }
      const f = pos(a, 'from');
      const t = pos(a, 'to');
      if (!f || !t) return null;
      return { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };
    }
    function deleteSelected() {
      const sid = selectedIdRef.current;
      const stype = selectedTypeRef.current;
      if (!sid) return;
      if (stype === 'node') {
        const next = pickReplacementAfterDelete(sid, 'node');
        onDeleteNodeRef.current(sid);
        if (next) {
          setSelectedId(next);
          setSelectedType('node');
        }
      } else if (stype === 'arrow') {
        const next = pickReplacementAfterDelete(sid, 'arrow');
        onDeleteArrowRef.current(sid);
        if (next) {
          setSelectedId(next);
          setSelectedType('arrow');
        }
      }
    }

    // ---- Arrow navigation (mirror of Tab nav for nodes) -------------
    function isArrowVisible(a) {
      const m = arrowApproxMid(a);
      if (!m) return false;
      const vp = viewportRef.current;
      const sx = m.x * vp.zoom + vp.panX;
      const sy = m.y * vp.zoom + vp.panY;
      return sx > 0 && sx < window.innerWidth && sy > 0 && sy < window.innerHeight;
    }
    function getVisibleArrows() {
      const all = stateRef.current.arrows;
      const r = [];
      for (const id of Object.keys(all)) {
        if (isArrowVisible(all[id])) r.push({ id, ...arrowApproxMid(all[id]) });
      }
      return r;
    }
    function navigateRowMajorArrow() {
      const visible = getVisibleArrows();
      if (visible.length === 0) return;
      const ROW_TOL = 30;
      visible.sort((a, b) => {
        if (Math.abs(a.y - b.y) > ROW_TOL) return a.y - b.y;
        return a.x - b.x;
      });
      const sid = (selectedTypeRef.current === 'arrow') ? selectedIdRef.current : null;
      const curIdx = sid ? visible.findIndex(v => v.id === sid) : -1;
      const nextIdx = (curIdx + 1) % visible.length;
      setSelectedId(visible[nextIdx].id);
      setSelectedType('arrow');
    }
    // Origin point for directional navigation: the centre of whatever is
    // currently selected (node, arrow or region). Both directional walkers use
    // it, so Cmd+WASD / .+WASD step ACROSS object types — the held key picks
    // the target type, the current selection only supplies the start point.
    function currentFocusPoint() {
      const sid = selectedIdRef.current;
      const stype = selectedTypeRef.current;
      if (!sid) return null;
      const st = stateRef.current;
      if (stype === 'node') {
        const n = st.nodes[sid];
        return n ? { x: n.x + (n.width || 220) / 2, y: n.y + (n.height || 60) / 2 } : null;
      }
      if (stype === 'arrow') {
        const a = st.arrows[sid];
        return a ? arrowApproxMid(a) : null;
      }
      if (stype === 'region') {
        const r = (st.regions || {})[sid];
        return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
      }
      return null;
    }
    // Directional step to the nearest visible object. `types` picks the
    // candidate pool: Cmd+WASD walks nodes AND arrows together, Tab+WASD
    // nodes only, .+WASD arrows only.
    function navigateDirectionalIn(dir, types) {
      const cands = [];
      if (types.includes('node')) {
        for (const c of getVisibleNodes()) {
          cands.push({ id: c.id, type: 'node', x: c.x + (c.width || 220) / 2, y: c.y + (c.height || 60) / 2 });
        }
      }
      if (types.includes('arrow')) {
        for (const v of getVisibleArrows()) cands.push({ id: v.id, type: 'arrow', x: v.x, y: v.y });
      }
      if (cands.length === 0) return;
      const origin = currentFocusPoint();
      if (!origin) {
        setSelectedId(cands[0].id);
        setSelectedType(cands[0].type);
        return;
      }
      const curId = selectedIdRef.current, curType = selectedTypeRef.current;
      let best = null, bestScore = Infinity;
      for (const c of cands) {
        if (c.id === curId && c.type === curType) continue;
        const ddx = c.x - origin.x, ddy = c.y - origin.y;
        let score;
        if (dir === 'up')         { if (ddy >= 0) continue; score = -ddy + Math.abs(ddx) * 2; }
        else if (dir === 'down')  { if (ddy <= 0) continue; score =  ddy + Math.abs(ddx) * 2; }
        else if (dir === 'left')  { if (ddx >= 0) continue; score = -ddx + Math.abs(ddy) * 2; }
        else                      { if (ddx <= 0) continue; score =  ddx + Math.abs(ddy) * 2; }
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (best) {
        setSelectedId(best.id);
        setSelectedType(best.type);
      }
    }
    const navigateDirectionalArrow = (dir) => navigateDirectionalIn(dir, ['arrow']);
    const navigateDirectional = (dir) => navigateDirectionalIn(dir, ['node']);
    const navigateDirectionalAny = (dir) => navigateDirectionalIn(dir, ['node', 'arrow']);

    // Cmd+F — pan so the selected node / arrow / region sits at the centre.
    function centerOnSelection() {
      const p = currentFocusPoint();
      if (!p) return false;
      const api = kbNudgeApiRef.current;
      if (api && typeof api.centerOn === 'function') {
        api.centerOn(p.x, p.y);
      } else {
        const vp = viewportRef.current;
        const update = onUpdateViewportRef.current;
        if (update) update({ ...vp, panX: window.innerWidth / 2 - p.x * vp.zoom, panY: window.innerHeight / 2 - p.y * vp.zoom });
      }
      return true;
    }

    // WASD continuous nudge.  Cursor-move (during arrow drag) goes through
    // setState because the preview is derived from React state. Node nudge
    // calls Canvas's imperative API so we don't trigger a full re-render
    // every tick (commit happens once on release).
    // RAF-driven, dt-based, smooth motion for everything WASD.
    //   - Pan: PAN_SPEED screen-pixels/sec (canvas scrolls under cursor).
    //   - Node nudge: NUDGE_SPEED world-units/sec; final position snaps to
    //     grid on key release (commit).
    //   - Arrow-drag cursor: same NUDGE_SPEED.
    const PAN_SPEED   = 1400; // px/sec
    const NUDGE_SPEED = 500; // world units/sec
    function frame(now) {
      const dirs = wasdDirsRef.current;
      if (dirs.size === 0) {
        wasdRafRef.current = 0;
        return;
      }
      const last = wasdLastFrameTimeRef.current;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      wasdLastFrameTimeRef.current = now;

      let vx = 0, vy = 0;
      if (dirs.has('left'))  vx -= 1;
      if (dirs.has('right')) vx += 1;
      if (dirs.has('up'))    vy -= 1;
      if (dirs.has('down'))  vy += 1;
      // Diagonal-speed normalization
      if (vx && vy) { const k = 1 / Math.SQRT2; vx *= k; vy *= k; }

      if (vx || vy) {
        if (kbArrowDragRef.current) {
          moveKbArrowCursor(vx * NUDGE_SPEED * dt, vy * NUDGE_SPEED * dt);
        } else {
          const sid = selectedIdRef.current;
          const stype = selectedTypeRef.current;
          const api = kbNudgeApiRef.current;
          if (sid && stype === 'node') {
            if (api && typeof api.nudge === 'function') {
              api.nudge(sid, vx * NUDGE_SPEED * dt, vy * NUDGE_SPEED * dt);
            }
          } else {
            // Pan canvas imperatively (no React re-render per frame).
            if (api && typeof api.pan === 'function') {
              api.pan(-vx * PAN_SPEED * dt, -vy * PAN_SPEED * dt);
            } else {
              const vp = viewportRef.current;
              const update = onUpdateViewportRef.current;
              if (update) update({ ...vp, panX: vp.panX - vx * PAN_SPEED * dt, panY: vp.panY - vy * PAN_SPEED * dt });
            }
          }
        }
      }
      wasdRafRef.current = requestAnimationFrame(frame);
    }
    function startFrameLoop() {
      if (wasdRafRef.current) return;
      wasdLastFrameTimeRef.current = 0;
      wasdRafRef.current = requestAnimationFrame(frame);
    }
    function dirOf(e) {
      switch (e.code) {
        case 'KeyW': return 'up';
        case 'KeyS': return 'down';
        case 'KeyA': return 'left';
        case 'KeyD': return 'right';
        default: return null;
      }
    }

    function onDown(e) {
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;

      // Delete / Backspace → remove the selected node or arrow, fall back
      // selection onto the previously-created sibling (or nearest if none).
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        deleteSelected();
        return;
      }

      if (e.code === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (!tabHeldRef.current) {
          tabHeldRef.current = true;
          tabConsumedRef.current = false;
        }
        return;
      }

      // `.` (plain Period, no shift) — held = arrow-nav modifier.
      if (e.code === 'Period' && !e.shiftKey) {
        e.preventDefault();
        if (!gtHeldRef.current) {
          gtHeldRef.current = true;
          gtConsumedRef.current = false;
        }
        return;
      }

      // Tab + Q  → clear current selection (deselect node / arrow).
      if (tabHeldRef.current && e.code === 'KeyQ') {
        e.preventDefault();
        tabConsumedRef.current = true;
        setSelectedId(null);
        setSelectedType(null);
        return;
      }
      // > + Q → also clears selection.
      if (gtHeldRef.current && e.code === 'KeyQ') {
        e.preventDefault();
        gtConsumedRef.current = true;
        setSelectedId(null);
        setSelectedType(null);
        return;
      }

      const cmd = e.metaKey || e.ctrlKey;
      // Shift+letter is the kind-assignment chord (separate handler) — never
      // treat it as movement / arrow-drag input here.
      if (e.shiftKey) return;

      const arrowAnchor = ANCHOR_OF[e.code];
      if (arrowAnchor && !e.altKey && !cmd) {
        e.preventDefault();
        if (heldArrowKeyRef.current) return;
        heldArrowKeyRef.current = e.code;
        startKbArrowDrag(arrowAnchor);
        return;
      }

      if (cmd && !e.altKey && e.code === 'KeyF') {
        if (centerOnSelection()) { e.preventDefault(); e.stopPropagation(); }
        return;
      }

      const dir = dirOf(e);
      if (!dir) return;
      // Option+WASD is reserved for resize (handled in the dev-mode effect) —
      // bail here so the node doesn't also nudge.
      if (e.altKey) return;
      e.preventDefault();

      // Cmd+WASD → step to the neighbouring node OR arrow, whichever is
      // nearest; Tab-held → nodes only (bare WASD moves the selected node).
      if (cmd) {
        navigateDirectionalAny(dir);
        return;
      }
      if (tabHeldRef.current) {
        tabConsumedRef.current = true;
        navigateDirectional(dir);
        return;
      }
      if (gtHeldRef.current) {
        gtConsumedRef.current = true;
        navigateDirectionalArrow(dir);
        return;
      }

      const dirs = wasdDirsRef.current;
      if (dirs.has(dir)) return;
      dirs.add(dir);
      startFrameLoop();
    }
    function onUp(e) {
      if (e.code === 'Tab') {
        e.preventDefault();
        if (!tabConsumedRef.current) navigateRowMajor();
        tabHeldRef.current = false;
        tabConsumedRef.current = false;
        return;
      }
      if (e.code === 'Period' && gtHeldRef.current) {
        e.preventDefault();
        if (!gtConsumedRef.current) navigateRowMajorArrow();
        gtHeldRef.current = false;
        gtConsumedRef.current = false;
        return;
      }
      if (e.code === heldArrowKeyRef.current) {
        heldArrowKeyRef.current = null;
        endKbArrowDrag();
        return;
      }
      const dir = dirOf(e);
      if (!dir) return;
      const dirs = wasdDirsRef.current;
      dirs.delete(dir);
      if (dirs.size === 0) {
        // Frame loop will exit on its next tick. Commit any imperative
        // state to React in one shot.
        const api = kbNudgeApiRef.current;
        if (api) {
          if (typeof api.commit === 'function')    api.commit();
          if (typeof api.panCommit === 'function') api.panCommit();
        }
      }
    }

    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      if (wasdRafRef.current) {
        cancelAnimationFrame(wasdRafRef.current);
        wasdRafRef.current = 0;
      }
      wasdDirsRef.current.clear();
    };
  }, [mode]);

  // Zoom hotkeys (dev mode):
  //   + / = (held)  → smooth zoom in  via RAF (no OS keyrepeat pause)
  //   -   (held)    → smooth zoom out
  //   0             → reset zoom to 1 (keep pan)
  useEffect(() => {
    if (mode !== 'dev') return;

    const ZOOM_RATE = 4.0; // multiplier per second when held (× per sec)
    function zoomFrame(now) {
      const keys = zoomKeysRef.current;
      if (keys.size === 0) {
        zoomRafRef.current = 0;
        return;
      }
      const last = zoomLastFrameTimeRef.current;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      zoomLastFrameTimeRef.current = now;
      let factor = 1;
      if (keys.has('in'))  factor *= Math.pow(ZOOM_RATE, dt);
      if (keys.has('out')) factor *= Math.pow(1 / ZOOM_RATE, dt);
      if (factor !== 1) {
        const api = kbNudgeApiRef.current;
        if (api && typeof api.zoom === 'function') {
          api.zoom(factor);
        } else {
          const vp = viewportRef.current;
          const update = onUpdateViewportRef.current;
          if (update) {
            let newZoom = vp.zoom * factor;
            newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
            const scale = newZoom / vp.zoom;
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            update({
              zoom: newZoom,
              panX: cx - (cx - vp.panX) * scale,
              panY: cy - (cy - vp.panY) * scale,
            });
          }
        }
      }
      zoomRafRef.current = requestAnimationFrame(zoomFrame);
    }
    function startZoomLoop() {
      if (zoomRafRef.current) return;
      zoomLastFrameTimeRef.current = 0;
      zoomRafRef.current = requestAnimationFrame(zoomFrame);
    }

    function onDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      const keys = zoomKeysRef.current;
      if (e.code === 'Equal') {
        e.preventDefault();
        if (keys.has('in')) return;
        keys.add('in');
        // Take an immediate small step so a quick tap still zooms.
        const api = kbNudgeApiRef.current;
        if (api?.zoom) api.zoom(1.05);
        startZoomLoop();
      } else if (e.code === 'Minus') {
        e.preventDefault();
        if (keys.has('out')) return;
        keys.add('out');
        const api = kbNudgeApiRef.current;
        if (api?.zoom) api.zoom(1 / 1.05);
        startZoomLoop();
      } else if (e.code === 'Digit0' && !e.shiftKey) {
        e.preventDefault();
        const vp = viewportRef.current;
        const update = onUpdateViewportRef.current;
        if (update) update({ ...vp, zoom: defaultZoom });
      }
    }
    function onUp(e) {
      const keys = zoomKeysRef.current;
      if (e.code === 'Equal') keys.delete('in');
      else if (e.code === 'Minus') keys.delete('out');
      else return;
      if (keys.size === 0) {
        // Frame loop will end. Commit imperative zoom state to React.
        const api = kbNudgeApiRef.current;
        if (api?.zoomCommit) api.zoomCommit();
      }
    }
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      if (zoomRafRef.current) {
        cancelAnimationFrame(zoomRafRef.current);
        zoomRafRef.current = 0;
      }
      zoomKeysRef.current.clear();
    };
  }, [mode]);

  // Shift + letter — context-sensitive kind setter:
  //   - node selected:  set node kind
  //   - arrow selected: set arrow kind (relations + operator letters)
  //   - nothing selected: spawn a node with that kind at viewport centre
  // Also Shift+1 (!) toggles NOT and Shift+5 (%) toggles probability on
  // the selected node. All of these only fire in dev mode so the same
  // letters typed inside an edited node aren't intercepted.
  useEffect(() => {
    if (mode !== 'dev') return;

    const NODE_KIND_OF = {
      KeyD: 'definition', KeyP: 'postulate', KeyU: 'assumption', KeyB: 'belief',
      KeyT: 'thesis', KeyF: 'fact', KeyO: 'objection', KeyR: 'response',
      KeyQ: 'question', KeyC: 'conclusion', KeyS: 'source',
    };
    // Cmd/Ctrl + Shift + letter — the second half of each mnemonic pair.
    const NODE_KIND_CMD = { KeyA: 'axiom', KeyP: 'premise', KeyS: 'scope' };
    // Arrow kinds reuse the same letters — the selection decides which map wins.
    const ARROW_KIND_OF = {
      KeyA: 'and', KeyO: 'or', KeyX: 'xor', KeyI: 'implies', KeyT: 'therefore',
      KeyE: 'equivalently', KeyN: 'necessaryFor', KeyS: 'supports',
      KeyC: 'contradicts', KeyP: 'presupposes', KeyR: 'refines', KeyG: 'generalizes',
      KeyB: 'because', KeyU: 'but', KeyF: 'inOrderTo',
      Backquote: 'analogy', Equal: 'identical',
    };
    const ARROW_KIND_CMD = { KeyS: 'sufficientFor', KeyX: 'counterExample', KeyE: 'example' };
    // Shift + digit → colour the selection.
    const COLOR_OF = {
      Digit1: '#868e96', Digit2: '#ff6b6b', Digit3: '#ffa94d', Digit4: '#ffd43b',
      Digit5: '#69db7c', Digit6: '#38d9a9', Digit7: '#4dabf7', Digit8: '#cf7bf0',
      Digit9: '#f783ac', Digit0: '#ffffff',
    };

    function onKey(e) {
      if (!e.shiftKey) return;
      if (e.altKey) return;
      const cmd = e.metaKey || e.ctrlKey;
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;

      const sid = selectedIdRef.current;
      const stype = selectedTypeRef.current;

      // Cmd+Shift+1 = ! → toggle NOT (node, or an operator pill = ¬( … ));
      // Cmd+Shift+5 = % → toggle probability.
      if (cmd && (e.code === 'Digit1' || e.code === 'Digit5')) {
        if (stype === 'node' && sid) {
          const n = stateRef.current.nodes[sid];
          if (n) {
            e.preventDefault(); e.stopPropagation();
            if (e.code === 'Digit1') onUpdateNodeRef.current(sid, { negated: !n.negated });
            else onUpdateNodeRef.current(sid, { probability: n.probability != null ? null : 50 });
          }
        } else if (stype === 'arrow' && sid && e.code === 'Digit1') {
          const a = stateRef.current.arrows[sid];
          if (a && a.kind && EDGE_KINDS[a.kind] && EDGE_KINDS[a.kind].render === 'text') {
            e.preventDefault(); e.stopPropagation();
            onUpdateArrowRef.current?.(sid, { negated: !a.negated });
          }
        }
        return;
      }

      // Shift + 1…0 → colour whatever is selected.
      if (!cmd && COLOR_OF[e.code]) {
        if (!sid || !stype) return;
        e.preventDefault(); e.stopPropagation();
        const color = COLOR_OF[e.code];
        if (stype === 'node') onUpdateNodeRef.current(sid, { color });
        else if (stype === 'arrow') onUpdateArrowRef.current?.(sid, { color });
        else if (stype === 'region') onUpdateRegionRef.current?.(sid, { color });
        return;
      }

      // Clear the kind: Shift+N on a node, Cmd+Shift+N on an arrow (plain
      // Shift+N is "necessary condition for" there).
      const isNone = (e.code === 'KeyN') && (stype === 'arrow' ? cmd : !cmd);

      // Arrow selected → set arrow kind.
      if (stype === 'arrow' && sid && stateRef.current.arrows[sid]) {
        // Shift+P then −/= → probability shifters. Plain Shift+= is "identical",
        // so the P prefix is what disambiguates them.
        if (e.code === 'Minus' || e.code === 'Equal') {
          const chord = Date.now() - probChordRef.current < 1200;
          if (chord || e.code === 'Equal') {
            e.preventDefault(); e.stopPropagation();
            const kind = chord ? (e.code === 'Minus' ? 'probDecreases' : 'probIncreases') : 'identical';
            probChordRef.current = 0;
            if (kind === 'identical' && tryMergeIntoOperatorGroupRef.current?.(sid, kind)) return;
            onUpdateArrowRef.current?.(sid, { kind });
          }
          return;
        }
        let kind = null;
        if (!isNone) {
          kind = cmd ? ARROW_KIND_CMD[e.code] : ARROW_KIND_OF[e.code];
          if (!kind) return;
        }
        e.preventDefault(); e.stopPropagation();
        const candidateKind = isNone ? null : kind;
        // Arm the P-chord window so a following −/= converts it to prob±.
        probChordRef.current = (candidateKind === 'presupposes') ? Date.now() : 0;
        // n-ary fold: if this assignment would chain another ∧/∨/identical
        // into an existing same-kind group, merge instead of nesting.
        if (candidateKind && tryMergeIntoOperatorGroupRef.current?.(sid, candidateKind)) return;
        onUpdateArrowRef.current?.(sid, { kind: candidateKind });
        return;
      }

      // Node selected (or no selection) → set / spawn with node kind.
      let kind = null;
      if (!isNone) {
        kind = cmd ? NODE_KIND_CMD[e.code] : NODE_KIND_OF[e.code];
        if (!kind) return;
      }
      e.preventDefault();
      e.stopPropagation();
      const newKind = isNone ? null : kind;

      const node = stateRef.current.nodes[sid];
      if (sid && stype === 'node' && node) {
        onUpdateNodeRef.current(sid, { kind: newKind });
        return;
      }
      // No selection — spawn a new node at viewport centre with the kind.
      const vp = viewportRef.current;
      const sw = window.innerWidth, sh = window.innerHeight;
      const cx = (sw / 2 - vp.panX) / vp.zoom;
      const cy = (sh / 2 - vp.panY) / vp.zoom;
      const GRID = 20;
      const nx = Math.round((cx - NEW_W / 2) / GRID) * GRID;
      const ny = Math.round((cy - NEW_H / 2) / GRID) * GRID;
      const newId = onAddNodeRef.current(nx, ny);
      if (newId && newKind) onUpdateNodeRef.current(newId, { kind: newKind });
      if (newId) {
        setSelectedId(newId);
        setSelectedType('node');
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  /* ================================================================
     Dev-mode: N = new node · ` = properties panel · Option+WASD = resize
     Resize pins the node's top-left: Option+W/S move the bottom edge up/down,
     Option+A/D move the right edge left/right.
     ================================================================ */
  useEffect(() => {
    if (mode !== 'dev') return;
    const GRID = 20, MIN_W = 60, MIN_H = 40;
    function onKey(e) {
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      const cmd = e.metaKey || e.ctrlKey;
      const sid = selectedIdRef.current;
      const stype = selectedTypeRef.current;

      // Option + W/S/A/D → resize the selected node / region (top-left pinned).
      if (e.altKey && !e.shiftKey && !cmd && ['KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code)) {
        if (!sid || (stype !== 'node' && stype !== 'region')) return;
        e.preventDefault(); e.stopPropagation();
        const step = GRID;
        if (stype === 'node') {
          const n = stateRef.current.nodes[sid];
          if (!n) return;
          const w = n.width || 220, h = n.height || 60;
          // A deliberate width is a manual size: stop fitting to text from now on.
          if (e.code === 'KeyD') onUpdateNodeRef.current(sid, { width: w + step, fitWidth: false });
          else if (e.code === 'KeyA') onUpdateNodeRef.current(sid, { width: Math.max(MIN_W, w - step), fitWidth: false });
          else if (e.code === 'KeyS') onUpdateNodeRef.current(sid, { height: h + step });
          else onUpdateNodeRef.current(sid, { height: Math.max(MIN_H, h - step) });
        } else {
          const r = (stateRef.current.regions || {})[sid];
          if (!r) return;
          if (e.code === 'KeyD') onUpdateRegionRef.current?.(sid, { w: r.w + step });
          else if (e.code === 'KeyA') onUpdateRegionRef.current?.(sid, { w: Math.max(MIN_W, r.w - step) });
          else if (e.code === 'KeyS') onUpdateRegionRef.current?.(sid, { h: r.h + step });
          else onUpdateRegionRef.current?.(sid, { h: Math.max(MIN_H, r.h - step) });
        }
        return;
      }

      if (e.altKey) return;

      // ` → toggle the properties panel (it no longer opens on selection).
      if (!cmd && !e.shiftKey && e.code === 'Backquote') {
        e.preventDefault(); e.stopPropagation();
        setPropsOpen((v) => !v);
        return;
      }

      // T / V on a selected node → text / vertical alignment, cycling only the
      // two used settings: centre ⇄ left, centre ⇄ top.
      if (!cmd && !e.shiftKey && (e.code === 'KeyT' || e.code === 'KeyV')) {
        const sid = selectedIdRef.current;
        const n = sid && selectedTypeRef.current === 'node' ? stateRef.current.nodes[sid] : null;
        if (n) {
          e.preventDefault(); e.stopPropagation();
          if (e.code === 'KeyT') onUpdateNodeRef.current(sid, { align: n.align === 'center' ? 'left' : 'center' });
          else onUpdateNodeRef.current(sid, { valign: n.valign === 'center' ? 'top' : 'center' });
          return;
        }
      }

      // N → new node at the viewport centre, ready to type.
      if (!cmd && !e.shiftKey && e.code === 'KeyN') {
        e.preventDefault(); e.stopPropagation();
        const vp = viewportRef.current;
        const cx = (window.innerWidth / 2 - vp.panX) / vp.zoom;
        const cy = (window.innerHeight / 2 - vp.panY) / vp.zoom;
        const nx = Math.round((cx - 110) / GRID) * GRID;
        const ny = Math.round((cy - 30) / GRID) * GRID;
        const newId = onAddNodeRef.current(nx, ny);
        if (newId) {
          setSelectedId(newId); setSelectedType('node');
          lastEditedRef.current = newId;
          setEditingNodeId(newId); setMode('edit');
        }
        return;
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  /* ================================================================
     Keyboard shortcuts
     ================================================================ */
  useEffect(() => {
    function onKeyDown(e) {
      // Don't capture keys while typing in a node
      const active = document.activeElement;
      if (active && active.contentEditable === 'true') return;

      // Copy / cut / paste objects (⌘C ⌘X ⌘V).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV')) {
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        if (e.code === 'KeyV') { e.preventDefault(); pasteFromClipboard(); return; }
        if (!copySelection()) return;
        e.preventDefault();
        if (e.code === 'KeyX') {
          if (selection.nodeIds.size > 0 || selection.arrowIds.size > 0 || selection.strokeIds.size > 0) onDeleteSelection();
          else if (selectedId && selectedType === 'node') onDeleteNode(selectedId);
          else if (selectedId && selectedType === 'arrow') onDeleteArrow(selectedId);
          else if (selectedId && selectedType === 'region') { onDeleteRegion(selectedId); setSelectedId(null); setSelectedType(null); }
        }
        return;
      }

      // Undo: Ctrl+Z / Cmd+Z (without shift)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'Z' && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      // Also handle Ctrl+Y for redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Delete selection first
        if (selection.nodeIds.size > 0 || selection.arrowIds.size > 0 || selection.strokeIds.size > 0) {
          e.preventDefault();
          onDeleteSelection();
          return;
        }
        if (selectedId && selectedType === 'node') {
          e.preventDefault();
          onDeleteNode(selectedId);
        } else if (selectedId && selectedType === 'arrow') {
          e.preventDefault();
          onDeleteArrow(selectedId);
        } else if (selectedId && selectedType === 'region') {
          e.preventDefault();
          onDeleteRegion(selectedId);
          setSelectedId(null);
          setSelectedType(null);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setSelectedType(null);
        setSelection({ nodeIds: new Set(), arrowIds: new Set(), strokeIds: new Set() });
        if (toolMode !== 'select') setToolMode('select');
        setShowDrawOptions(false);
      }
    }
    // Capture-phase: the Obsidian key-isolation `stop` listener (also capture)
    // calls stopPropagation, which kills the bubble phase. Registering here in
    // capture — like every other board handler — is what lets multi-select
    // delete and region delete fire inside Obsidian.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selectedId, selectedType, onDeleteNode, onDeleteArrow, onDeleteRegion, selection, onDeleteSelection, undo, redo, toolMode, copySelection, pasteFromClipboard]);

  /* ================================================================
     Draw button double-tap handler
     ================================================================ */
  const switchPenKind = useCallback((kind) => {
    if (kind === penKind) return;
    setPenKind(kind);
  }, [penKind]);

  // Pen / highlighter buttons: pick that pen; pressing the active one again
  // shows / hides its options bar.
  const pickPen = useCallback((kind) => {
    if (toolMode === 'draw' && penKind === kind) { setPenPanelOpen((v) => !v); return; }
    switchPenKind(kind);
    setToolMode('draw');
  }, [toolMode, penKind, switchPenKind]);

  // Selection popup: any press on the board (outside the popup), a scroll or
  // a change of the selection closes it; a click on the selection reopens it.
  useEffect(() => { setSelPopup(null); }, [selection]);
  useEffect(() => {
    if (!selPopup) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const close = (e) => {
      if (e.target && e.target.closest && e.target.closest('.sel-popup')) return;
      setSelPopup(null);
    };
    root.addEventListener('mousedown', close, true);
    root.addEventListener('touchstart', close, true);
    root.addEventListener('wheel', close, true);
    return () => {
      root.removeEventListener('mousedown', close, true);
      root.removeEventListener('touchstart', close, true);
      root.removeEventListener('wheel', close, true);
    };
  }, [selPopup]);
  // Placed above the selection when there is room (clear of the rotate
  // handle), otherwise below it, otherwise pinned inside the view.
  useLayoutEffect(() => {
    const el = selPopupRef.current;
    const root = rootRef.current;
    if (!el || !root || !selPopup || !el.classList.contains('sel-popup')) return;
    const canvas = root.querySelector('.canvas-root') || root;
    const cr = canvas.getBoundingClientRect();
    const vp = getActualViewport();
    const top = cr.top + vp.panY + selPopup.y * vp.zoom;
    const bottom = top + selPopup.h * vp.zoom;
    const cx = cr.left + vp.panX + (selPopup.x + selPopup.w / 2) * vp.zoom;
    // Panels can carry a CSS `zoom` (UI scale): measure on screen, write unscaled.
    const er = el.getBoundingClientRect();
    const w = er.width, h = er.height;
    const k = el.offsetWidth ? er.width / el.offsetWidth : 1;
    const minTop = cr.top + 8, maxBottom = cr.bottom - 8;
    let y;
    if (top - 52 - h >= minTop) y = top - 52 - h;
    else if (bottom + 20 + h <= maxBottom) y = bottom + 20;
    else y = Math.max(minTop, maxBottom - h);
    const x = Math.max(cr.left + 8, Math.min(cr.right - 8 - w, cx - w / 2));
    // `fixed` on the web, `absolute` inside the plugin's pane.
    const base = el.offsetParent ? el.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    el.style.left = `${Math.round((x - base.left) / k)}px`;
    el.style.top = `${Math.round((y - base.top) / k)}px`;
    el.style.visibility = 'visible';
  });

  // Digit hotkeys reach these through a ref (their listener is bound once).
  useEffect(() => {
    hotkeyRef.current.pen = (kind) => { switchPenKind(kind); setToolMode('draw'); };
  }, [switchPenKind]);
  useEffect(() => { hotkeyRef.current.text = () => handleAddTextRef.current && handleAddTextRef.current(); }, []);
  const handleAddTextRef = useRef(null);

  /* ================================================================
     Toolbar actions
     ================================================================ */
  // Get actual viewport from DOM (React state may lag behind DOM-direct pan)
  const getActualViewport = useCallback(() => {
    const el = document.querySelector('.canvas-transform');
    if (el) {
      const style = el.style.transform;
      const m = style.match(/translate\(([^,]+)px,\s*([^)]+)px\)\s*scale\(([^)]+)\)/);
      if (m) return { panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) };
    }
    return viewport;
  }, [viewport]);

  const handleAddNode = useCallback(() => {
    const vp = getActualViewport();
    const cx = (window.innerWidth / 2 - vp.panX) / vp.zoom;
    const cy = (window.innerHeight / 2 - vp.panY) / vp.zoom;
    const GRID = 20;
    onAddNode(Math.round((cx - 110) / GRID) * GRID, Math.round((cy - 30) / GRID) * GRID);
  }, [getActualViewport, onAddNode]);

  const handleAddText = useCallback(() => {
    const vp = getActualViewport();
    const cx = (window.innerWidth / 2 - vp.panX) / vp.zoom;
    const cy = (window.innerHeight / 2 - vp.panY) / vp.zoom;
    const GRID = 20;
    const id = genId();
    const node = { id, x: Math.round((cx - 80) / GRID) * GRID, y: Math.round((cy - 20) / GRID) * GRID, text: '', color: '#ffffff', width: 160, style: 'text' };
    setStateWithHistory((prev) => ({ ...prev, nodes: { ...prev.nodes, [id]: node } }));
    send({ type: 'node:add', node });
    setSelectedId(id);
    setSelectedType('node');
  }, [getActualViewport, setStateWithHistory, send]);

  useEffect(() => { handleAddTextRef.current = handleAddText; }, [handleAddText]);

  const handleAddRegion = useCallback(() => {
    const vp = getActualViewport();
    const cx = (window.innerWidth / 2 - vp.panX) / vp.zoom;
    const cy = (window.innerHeight / 2 - vp.panY) / vp.zoom;
    const GRID = 20;
    const id = genId('r');
    const region = {
      id,
      x: Math.round((cx - 150) / GRID) * GRID,
      y: Math.round((cy - 100) / GRID) * GRID,
      w: 300,
      h: 200,
      color: '#cf7bf0',
    };
    onAddRegion(region);
    setSelectedId(id);
    setSelectedType('region');
  }, [getActualViewport, onAddRegion]);

  // Figure shapes — rectangle / square / circle / ellipse / triangle. A figure
  // is a node with a `shape` field (reuses node drag/resize/select/color/sync).
  // square & circle keep a 1:1 aspect; rect & ellipse are free.
  const handleAddFigure = useCallback((shape) => {
    const vp = getActualViewport();
    const cx = (window.innerWidth / 2 - vp.panX) / vp.zoom;
    const cy = (window.innerHeight / 2 - vp.panY) / vp.zoom;
    const GRID = 20;
    const dims = (shape === 'rect' || shape === 'ellipse') ? { w: 200, h: 120 } : { w: 140, h: 140 };
    const id = genId();
    const node = {
      id, shape,
      x: Math.round((cx - dims.w / 2) / GRID) * GRID,
      y: Math.round((cy - dims.h / 2) / GRID) * GRID,
      width: dims.w, height: dims.h,
      text: '', color: '#ffffff',
    };
    setStateWithHistory((prev) => ({ ...prev, nodes: { ...prev.nodes, [id]: node } }));
    send({ type: 'node:add', node });
    setSelectedId(id);
    setSelectedType('node');
  }, [getActualViewport, setStateWithHistory, send]);

  // Excalidraw-style placement: create a node / region / figure with an
  // explicit world-space box (from a click or a drag rectangle). After
  // placing, drop back to the select tool so it can be edited/moved.
  const onPlaceObject = useCallback((kind, shape, x, y, w, h) => {
    const GRID = 20;
    const sn = (v) => Math.round(v / GRID) * GRID;
    x = sn(x); y = sn(y);
    w = Math.max(GRID * 3, sn(w));
    h = Math.max(GRID * 2, sn(h));
    if (kind === 'region') {
      const id = genId('r');
      const region = { id, x, y, w, h, color: '#ffffff' };
      onAddRegion(region);
      setSelectedId(id);
      setSelectedType('region');
    } else {
      const id = genId();
      // A plain click (default size) fits the node to its text; a dragged box is a deliberate size.
      const node = { id, x, y, width: w, height: h, text: '', color: '#ffffff', fitWidth: kind === 'node' && w <= NEW_W && h <= NEW_H };
      if (kind === 'figure') node.shape = shape;
      setStateWithHistory((prev) => ({ ...prev, nodes: { ...prev.nodes, [id]: node } }));
      send({ type: 'node:add', node });
      setSelectedId(id);
      setSelectedType('node');
      if (kind === 'node') {
        // A fresh node → leave placement mode and open edit so you can type
        // straight away (and a later click on it edits, not spawns a nested one).
        setToolMode('select');
        lastEditedRef.current = id;
        setEditingNodeId(id);
        setMode('edit');
        return;
      }
    }
    // Figures / regions: stay in the placement mode so several can be drawn in
    // a row; the user exits with `1` / Esc / the toolbar.
  }, [onAddRegion, setStateWithHistory, send]);

  // Markdown formatting (node properties toolbar). If a node's text is being
  // edited, wrap the current selection via execCommand; otherwise wrap the
  // whole selected node's text.
  const applyFormat = useCallback((type, arg) => {
    // Symmetric wraps — markdown delimiters and inline HTML tags. Underline,
    // highlight, sup, sub aren't standard markdown but are allowed by
    // DOMPurify by default so they pass through the rich-text renderer.
    const WRAP = {
      bold: ['**', '**'], italic: ['*', '*'], bolditalic: ['***', '***'],
      strike: ['~~', '~~'], underline: ['<u>', '</u>'],
      sup: ['<sup>', '</sup>'], sub: ['<sub>', '</sub>'],
      code: ['`', '`'],
    };
    const PREFIX = {
      h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '##### ', h6: '###### ',
      ul: '- ', ol: '1. ', task: '- [ ] ', quote: '> ',
    };
    const build = (text) => {
      if (type === 'highlight') {
        const color = arg || '#ffd54f';
        return `<mark style="background:${color}">${text}</mark>`;
      }
      const w = WRAP[type];
      if (w) return w[0] + text + w[1];
      if (PREFIX[type]) return PREFIX[type] + text;
      if (type === 'link') return `[${text || 'text'}](url)`;
      if (type === 'codeblock') return '```\n' + (text || 'code') + '\n```';
      return text;
    };
    const el = document.activeElement;
    if (el && el.classList && el.classList.contains('node-text') && el.isContentEditable) {
      const sel = window.getSelection();
      const selected = sel && sel.rangeCount ? sel.toString() : '';
      document.execCommand('insertText', false, build(selected));
      return;
    }
    if (!selectedId || selectedType !== 'node') return;
    const cur = nodes[selectedId]?.text || '';
    const next = build(cur);
    setStateWithHistory((prev) => {
      const n = prev.nodes[selectedId];
      if (!n) return prev;
      return { ...prev, nodes: { ...prev.nodes, [selectedId]: { ...n, text: next } } };
    });
    send({ type: 'node:update', id: selectedId, updates: { text: next } });
  }, [selectedId, selectedType, nodes, setStateWithHistory, send]);

  const handleZoomIn = useCallback(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let newZoom = viewport.zoom * 1.2;
    newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const scale = newZoom / viewport.zoom;
    onUpdateViewport({
      zoom: newZoom,
      panX: cx - (cx - viewport.panX) * scale,
      panY: cy - (cy - viewport.panY) * scale,
    });
  }, [viewport, onUpdateViewport]);

  const handleZoomOut = useCallback(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let newZoom = viewport.zoom / 1.2;
    newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const scale = newZoom / viewport.zoom;
    onUpdateViewport({
      zoom: newZoom,
      panX: cx - (cx - viewport.panX) * scale,
      panY: cy - (cy - viewport.panY) * scale,
    });
  }, [viewport, onUpdateViewport]);

  const handleFitView = useCallback(() => {
    if (layoutRef.current) { fitPage(); return; } // document: current page, full width
    // Everything counts: nodes, regions and ink.
    const cb = contentBounds(stateRef.current);
    if (!cb) {
      onUpdateViewport({ panX: 0, panY: 0, zoom: defaultZoom });
      return;
    }
    const minX = cb.x0, minY = cb.y0, maxX = cb.x1, maxY = cb.y1 + 20;
    const padding = 80;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const scaleX = window.innerWidth / contentW;
    const scaleY = window.innerHeight / contentH;
    let zoom = Math.min(scaleX, scaleY, 1.5);
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const panX = (window.innerWidth - contentW * zoom) / 2 - (minX - padding) * zoom;
    const panY = (window.innerHeight - contentH * zoom) / 2 - (minY - padding) * zoom;
    onUpdateViewport({ panX, panY, zoom });
  }, [nodes, onUpdateViewport, fitPage]);

  // Board → DSL on the clipboard (the whole board, or the selection if any).
  const copyDsl = useCallback(() => {
    const st = stateRef.current;
    const selIds = selection.nodeIds.size ? selection.nodeIds : (selectedType === 'node' && selectedId ? new Set([selectedId]) : null);
    let sub = { nodes: st.nodes, arrows: st.arrows, regions: st.regions || {}, doc: st.doc };
    if (selIds) {
      const nodes = Object.fromEntries(Object.entries(st.nodes).filter(([id]) => selIds.has(id)));
      const keep = (a) => (!a.fromNodeId || nodes[a.fromNodeId]) && (!a.toNodeId || nodes[a.toNodeId]) && !a.fromRegionId && !a.toRegionId;
      const arrows = Object.fromEntries(Object.entries(st.arrows).filter(([, a]) => keep(a)));
      sub = { nodes, arrows, regions: {} };
    }
    const { text } = serializeToDsl(sub);
    navigator.clipboard?.writeText(text);
  }, [selection, selectedId, selectedType]);

  const copyDslRef = useRef(copyDsl);
  useEffect(() => { copyDslRef.current = copyDsl; }, [copyDsl]);

  // DSL → graph. Lays out the parsed graph with dagre and merges it into the
  // current board (placed to the right of existing content), then fits view.
  // Returns { count, errors }.
  const onImportDsl = useCallback((text) => {
    // Place the new graph just past the right edge of existing content.
    const arr = Object.values(nodes);
    let origin;
    if (arr.length) {
      let maxX = -Infinity, minY = Infinity;
      for (const n of arr) { maxX = Math.max(maxX, n.x + (n.width || 220)); minY = Math.min(minY, n.y); }
      origin = { x: maxX + 120, y: minY };
    } else {
      const vp = getActualViewport();
      origin = { x: (-vp.panX) / vp.zoom + 80, y: (-vp.panY) / vp.zoom + 120 };
    }

    const built = buildGraphFromDsl(text, genId, origin);
    // `doc = pages(...)` — board setup carried by the text.
    if (built.doc !== undefined) changeDoc(built.doc || null);
    if (built.count === 0 && built.doc !== undefined) return { count: 0, errors: built.errors };
    if (built.count === 0) return { count: 0, errors: built.errors.length ? built.errors : ['Nothing to import.'] };

    const addNodes = {};
    for (const n of built.nodes) addNodes[n.id] = n;
    const addArrows = {};
    for (const a of built.arrows) addArrows[a.id] = a;
    const addRegions = {};
    for (const r of (built.regions || [])) addRegions[r.id] = r;

    setStateWithHistory((prev) => ({
      ...prev,
      nodes: { ...prev.nodes, ...addNodes },
      arrows: { ...prev.arrows, ...addArrows },
      regions: { ...(prev.regions || {}), ...addRegions },
    }));
    for (const n of built.nodes) send({ type: 'node:add', node: n });
    for (const a of built.arrows) send({ type: 'arrow:add', arrow: a });
    for (const r of (built.regions || [])) send({ type: 'region:add', region: r });

    // Frame the freshly added graph.
    setTimeout(() => handleFitView(), 0);
    return { count: built.count, errors: built.errors };
  }, [nodes, getActualViewport, setStateWithHistory, send, handleFitView, changeDoc]);

  /* ================================================================
     Tool shortcuts: digits 1–8 pick a tool; `?` toggles the cheat-sheet.
     ================================================================ */
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;

      // `?` (Shift+/) toggles the shortcuts overlay.
      // ⌘⇧U — import from text; ⌘⇧X — copy board (or selection) as text.
      // (⌘⇧I / ⌘⇧C are Chrome's DevTools shortcuts, so not those.)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyU') { e.preventDefault(); setDslOpen(true); return; }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyX') { e.preventDefault(); copyDslRef.current(); return; }
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (showShortcuts && e.key === 'Escape') {
        setShowShortcuts(false);
        return;
      }
      if (e.shiftKey) return; // leave Shift+letter (kinds) alone

      // Figure two-key combo: `9` then 1–5 picks the shape, enters figure mode.
      const FIG = { Digit1: 'rect', Digit2: 'square', Digit3: 'circle', Digit4: 'ellipse', Digit5: 'triangle' };
      if (figurePendingRef.current && (Date.now() - figurePendingRef.current) < 1500 && FIG[e.code]) {
        figurePendingRef.current = 0;
        setFigureShape(FIG[e.code]); setToolMode('figure');
        e.preventDefault();
        return;
      }
      if (e.code === 'Digit9') { figurePendingRef.current = Date.now(); e.preventDefault(); return; }
      figurePendingRef.current = 0;

      // Digits follow the toolbar left to right: 1 Select (again: rectangle ⇄
      // lasso) · 2 Pen · 3 Highlighter · 4 Eraser · 5 Text · 6 Node · 7 Arrow ·
      // 8 Region · 9X Figure · H Move (0 stays zoom reset). Node/Region/Figure are placement MODES —
      // click or drag on the canvas to create.
      switch (e.code) {
        case 'Digit1': {
          const cur = toolModeRef.current;
          if (cur === 'select' || cur === 'lasso') setSelectKind((k) => (k === 'lasso' ? 'rect' : 'lasso'));
          setToolMode('select'); setShowDrawOptions(false); break;
        }
        case 'Digit2': hotkeyRef.current.pen('pen'); break;
        case 'Digit3': hotkeyRef.current.pen('highlighter'); break;
        case 'Digit4': setToolMode('eraser'); setShowDrawOptions(false); break;
        case 'Digit5': hotkeyRef.current.text(); break;
        case 'Digit6': setToolMode('node'); break;
        case 'Digit7': setToolMode('arrow'); setShowDrawOptions(false); break;
        case 'Digit8': setToolMode('region'); break;
        case 'KeyH': if (e.metaKey || e.ctrlKey || e.altKey) return; setToolMode('move'); setShowDrawOptions(false); break;
        default: return;
      }
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showShortcuts]);

  /* ================================================================
     Color picker
     ================================================================ */
  const handleColorChange = useCallback((color) => {
    if (toolMode === 'draw') {
      setDrawColor(color);
    } else if (selectedId && selectedType === 'node') {
      onUpdateNode(selectedId, { color });
      pushHistorySnapshot({ ...state, nodes: { ...state.nodes, [selectedId]: { ...state.nodes[selectedId], color } } });
    } else if (selectedId && selectedType === 'arrow') {
      const newState = {
        ...state,
        arrows: { ...state.arrows, [selectedId]: { ...state.arrows[selectedId], color } },
      };
      setState(newState);
      pushHistorySnapshot(newState);
    } else if (selectedId && selectedType === 'region') {
      onUpdateRegion(selectedId, { color });
      pushHistorySnapshot({ ...state, regions: { ...state.regions, [selectedId]: { ...state.regions[selectedId], color } } });
    }
  }, [selectedId, selectedType, onUpdateNode, onUpdateRegion, toolMode, state, pushHistorySnapshot, setDrawColor]);

  const activeColor = toolMode === 'draw' ? drawColor
    : selectedId && selectedType === 'node' ? (nodes[selectedId]?.color || '#cf7bf0')
    : selectedId && selectedType === 'arrow' ? (arrows[selectedId]?.color || '#cf7bf0')
    : null;

  const showPalette = toolMode === 'draw' || selectedId;

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  /* ================================================================
     Render
     ================================================================ */
  /* Render */
  return (
    <div className={`catego-root${pagesOpen && layout ? ' pages-open' : ''}`} ref={rootRef}>
      {overlay}
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
        onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) addFiles(files); }} />
      {busyNote && <div className="busy-note">{busyNote}</div>}
      {/* Tools toolbar (centered, top) — icons only. Order: select, pen,
          highlighter, eraser, text, node, arrow, region, figure, move. */}
      <div className="toolbar toolbar-tools">
        <button
          className={`toolbar-btn${(toolMode === 'select' || toolMode === 'lasso') ? ' tool-active' : ''}`}
          onClick={() => ((toolMode === 'select' || toolMode === 'lasso') ? toggleOpts('select') : setToolMode('select'))}
          title="Select — press again to show / hide its options"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M3 2l2 12 3-4 5-1L3 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
          </svg>
          <span className="hk-pill">1</span>
        </button>
        <button
          className={`toolbar-btn${(toolMode === 'draw' && penKind === 'pen') ? ' tool-active' : ''}`}
          onClick={() => pickPen('pen')}
          title="Pen — press again to show / hide its options"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 13.5s1-2 3-4 4-3.5 5.5-5S13 2.5 13 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="hk-pill">2</span>
        </button>
        <button
          className={`toolbar-btn${(toolMode === 'draw' && penKind === 'highlighter') ? ' tool-active' : ''}`}
          onClick={() => pickPen('highlighter')}
          title="Highlighter — press again to show / hide its options"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M9.2 2.6l4.2 4.2-6 6H3.2V8.6l6-6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M2 14.6h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.55" />
          </svg>
          <span className="hk-pill">3</span>
        </button>
        <button
          className={`toolbar-btn${toolMode === 'eraser' ? ' tool-active' : ''}`}
          onClick={() => (toolMode === 'eraser' ? toggleOpts('eraser') : setToolMode('eraser'))}
          title="Eraser — press again to show / hide its options"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M6 14h8M3.5 11.5l7-7a1.41 1.41 0 012 2l-7 7H3l-.5-.5a1.41 1.41 0 010-2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="hk-pill">4</span>
        </button>
        <button className="toolbar-btn" onClick={handleAddText} title="Add Text">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M3 4V3h10v1M8 3v10M6 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="hk-pill">5</span>
        </button>
        <button
          className={`toolbar-btn${toolMode === 'node' ? ' tool-active' : ''}`}
          onClick={() => setToolMode(toolMode === 'node' ? 'select' : 'node')}
          title="Node (click or drag a box)"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="4.5" width="12" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <span className="hk-pill">6</span>
        </button>
        <button
          className={`toolbar-btn${toolMode === 'arrow' ? ' tool-active' : ''}`}
          onClick={() => setToolMode(toolMode === 'arrow' ? 'select' : 'arrow')}
          title="Arrow (drag on empty canvas to draw a connection)"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M3 13L13 3M8.5 3H13V7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="hk-pill">7</span>
        </button>
        <button
          className={`toolbar-btn${toolMode === 'region' ? ' tool-active' : ''}`}
          onClick={() => setToolMode(toolMode === 'region' ? 'select' : 'region')}
          title="Region — a named frame around a part of the board (drag a box)"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 6.2h11v7.3h-11z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M2.5 6.2V3.4h5v2.8" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M4.2 4.8h1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="hk-pill">8</span>
        </button>
        <div style={{ position: 'relative' }}>
          <button
            className={`toolbar-btn${figureMenuOpen || toolMode === 'figure' ? ' tool-active' : ''}`}
            onClick={() => setFigureMenuOpen((v) => !v)}
            title="Figure (pick a shape, then click or drag on the canvas)"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="7" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <circle cx="11" cy="5.5" r="3.4" stroke="currentColor" strokeWidth="1.4" fill="none" />
            </svg>
                    <span className="hk-pill">9</span>
        </button>
          {figureMenuOpen && (
            <div className="figure-menu">
              {[
                { shape: 'rect', title: 'Rectangle', icon: <rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" /> },
                { shape: 'square', title: 'Square', icon: <rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" /> },
                { shape: 'circle', title: 'Circle', icon: <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" /> },
                { shape: 'ellipse', title: 'Ellipse', icon: <ellipse cx="8" cy="8" rx="6.5" ry="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" /> },
                { shape: 'triangle', title: 'Triangle', icon: <polygon points="8,2 14,13 2,13" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" /> },
              ].map(({ shape, title, icon }, fi) => (
                <button
                  key={shape}
                  className={`toolbar-btn${toolMode === 'figure' && figureShape === shape ? ' tool-active' : ''}`}
                  onClick={() => { setFigureShape(shape); setToolMode('figure'); setFigureMenuOpen(false); }}
                  title={title}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">{icon}</svg>
                  <span className="hk-pill">{`9·${fi + 1}`}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="toolbar-btn" onClick={() => pickFiles(pdf ? 'image/*,application/pdf' : 'image/*')}
          title={pdf ? 'Picture or PDF — a PDF becomes sheets you can write on (⌘V pastes a picture)' : 'Picture (⌘V pastes one)'}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="12" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5.6" cy="6.4" r="1.1" fill="currentColor" />
            <path d="M2.6 11.6l3.3-3.1 2.3 2 2.2-2.6 3 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={`toolbar-btn${toolMode === 'space' ? ' tool-active' : ''}`}
          onClick={() => setToolMode(toolMode === 'space' ? 'select' : 'space')}
          title="Add space — drag down to push everything below further down (drag up to close a gap)"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M2 3h12M2 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M8 5.2v5.6M6 7l2-1.8L10 7M6 9l2 1.8L10 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={`toolbar-btn${toolMode === 'move' ? ' tool-active' : ''}`}
          onClick={() => setToolMode('move')}
          title="Move (pan)"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <path d="M8 1v14M1 8h14M8 1l-2.5 2.5M8 1l2.5 2.5M8 15l-2.5-2.5M8 15l2.5-2.5M1 8l2.5-2.5M1 8l2.5 2.5M15 8l-2.5-2.5M15 8l-2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="hk-pill">H</span>
        </button>

        {/* Options of the active tool — a slim bar hanging under the toolbar. */}
        {(toolMode === 'select' || toolMode === 'lasso') && !optsHidden.select && (
          <div className="tool-options">
            <button className={`opt-chip${selectKind === 'rect' ? ' active' : ''}`} onClick={() => setSelectKind('rect')} title="Drag a rectangle to select">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.4 1.8" /></svg>
              Rectangle
            </button>
            <button className={`opt-chip${selectKind === 'lasso' ? ' active' : ''}`} onClick={() => setSelectKind('lasso')} title="Draw a loop around ink and nodes (press 1 again)">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M8 2.2c3.3 0 5.8 1.6 5.8 3.9S11.3 10 8 10 2.2 8.4 2.2 6.1 4.7 2.2 8 2.2z" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.6 1.8" />
                <path d="M5.2 9.6c-.9.6-1.2 1.6-.6 2.3.6.7 1.7.5 2-.3.3-.9-.6-1.3-1.5-.9-1 .5-1.6 1.6-1.4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              Lasso
            </button>
            <span className="opt-sep" />
            {[['all', 'All', 'Select everything in the area'], ['ink', 'Ink', 'Select handwriting only'], ['objects', 'Objects', 'Select nodes, pictures and regions only']].map(([key, label, tip]) => (
              <button key={key} className={`opt-chip${selectFilter === key ? ' active' : ''}`} onClick={() => setSelectFilter(key)} title={tip}>{label}</button>
            ))}
          </div>
        )}
        {toolMode === 'space' && (
          <div className="tool-options">
            <span className="opt-hint">Drag down from a line to open space below it · drag up to close a gap</span>
          </div>
        )}
        {toolMode === 'draw' && penPanelOpen && (
          <div className="tool-options">
            <div className="opt-pens">
              {pens[penKind].map((pn, i) => {
                const d = penKind === 'highlighter' ? Math.max(5, Math.min(16, pn.width * 0.7)) : Math.max(3, Math.min(14, pn.width * 1.6));
                return (
                  <button key={i} className={`opt-pen${penKind === 'highlighter' ? ' hl' : ''}${penSlot[penKind] === i ? ' active' : ''}`} style={{ '--sw': pn.color }}
                    onClick={() => setPenSlot((ps) => ({ ...ps, [penKind]: i }))}
                    title={`${penKind === 'highlighter' ? 'Highlighter' : 'Pen'} ${i + 1} — it keeps its own colour, width and opacity`}>
                    <i style={penKind === 'highlighter' ? { width: 16, height: d } : { width: d, height: d }} />
                  </button>
                );
              })}
            </div>
            <span className="opt-sep" />
            <div className="opt-swatches">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`opt-swatch${drawColor === c ? ' active' : ''}`}
                  style={{ '--sw': c }}
                  onClick={() => setDrawColor(c)}
                  title={c}
                />
              ))}
            </div>
            <span className="opt-sep" />
            <label className="opt-slider" title={`Width ${drawWidth}`}>
              <span className="opt-dot" style={{ width: Math.max(3, Math.min(18, drawWidth * (penKind === 'highlighter' ? 0.7 : 1.6))), height: Math.max(3, Math.min(18, drawWidth * (penKind === 'highlighter' ? 0.7 : 1.6))), background: drawColor }} />
              <input
                type="range" min={penKind === 'highlighter' ? 4 : 0.5} max={penKind === 'highlighter' ? 30 : 10} step={penKind === 'highlighter' ? 1 : 0.5} value={drawWidth}
                onChange={(e) => setDrawWidth(Number(e.target.value))}
              />
              <span className="opt-num">{drawWidth}</span>
            </label>
            <span className="opt-sep" />
            <label className="opt-slider" title={`Opacity ${drawOpacity}%`}>
              <span className="opt-dot" style={{ width: 12, height: 12, background: drawColor, opacity: drawOpacity / 100 }} />
              <input
                type="range" min="1" max="100" step="1" value={drawOpacity}
                onChange={(e) => setDrawOpacity(Number(e.target.value))}
              />
              <span className="opt-num">{drawOpacity}%</span>
            </label>
            {penKind === 'highlighter' && (
              <>
                <span className="opt-sep" />
                <button className={`opt-chip${hlStraight ? ' active' : ''}`} onClick={() => setHlStraight((v) => !v)} title="Draw ruler-straight highlights (Shift snaps the angle)">Straight</button>
                {pdf && <button className={`opt-chip${hlText ? ' active' : ''}`} onClick={() => setHlText((v) => !v)} title="On a PDF page, a highlight that starts on text marks the text itself (and keeps its words)">Text</button>}
              </>
            )}
          </div>
        )}
        {toolMode === 'eraser' && !optsHidden.eraser && (
          <div className="tool-options">
            <button className={`opt-chip${eraserMode === 'object' ? ' active' : ''}`} onClick={() => setEraserMode('object')} title="Removes whole strokes and objects">Whole</button>
            <button className={`opt-chip${eraserMode === 'pixel' ? ' active' : ''}`} onClick={() => setEraserMode('pixel')} title="Rubs out parts of strokes">Partial</button>
            <span className="opt-sep" />
            <label className="opt-slider" title={`Size ${eraserRadius}`}>
              <span className="opt-dot hollow" style={{ width: Math.max(6, eraserRadius * 0.45), height: Math.max(6, eraserRadius * 0.45) }} />
              <input type="range" min="8" max="40" value={eraserRadius} onChange={(e) => setEraserRadius(Number(e.target.value))} />
            </label>
            <span className="opt-sep" />
            {[['all', 'All', 'Erases ink and objects'], ['ink', 'Ink', 'Erases handwriting only — nodes and pictures are safe'], ['pen', 'Pen', 'Erases pen strokes only'], ['hl', 'Marker', 'Erases highlighter only']].map(([key, label, tip]) => (
              <button key={key} className={`opt-chip${eraserTarget === key ? ' active' : ''}`} onClick={() => setEraserTarget(key)} title={tip}>{label}</button>
            ))}
            <span className="opt-sep" />
            <button className={`opt-chip${eraserAuto ? ' active' : ''}`} onClick={() => setEraserAuto((v) => !v)} title="After one erasing stroke, go back to the tool you were using">Auto-back</button>
          </div>
        )}
      </div>

      {/* Functions toolbar (top-right) — icons only */}
      <div className={`toolbar toolbar-functions${fnOpen ? ' open' : ' collapsed'}`}>
        <button
          className={`toolbar-btn fn-keep${fnOpen ? ' tool-active' : ''}`}
          onClick={() => setFnOpen((v) => !v)}
          title={fnOpen ? 'Hide tools' : 'More: zoom, export, page setup, duplicate, delete…'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="12.5" cy="8" r="1.4" />
          </svg>
        </button>
        {/* Undo / Redo */}
        <button
          className="toolbar-btn fn-keep"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 6h7a3 3 0 010 6H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 3L3 6l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
                  <span className="hk-pill">⌘Z</span>
        </button>
        <button
          className="toolbar-btn fn-keep"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M13 6H6a3 3 0 000 6h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
                  <span className="hk-pill">⇧⌘Z</span>
        </button>

        <div className="toolbar-divider" />

        {/* Zoom controls */}
        <button className="toolbar-btn" onClick={handleZoomIn} title="Zoom In">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M7 5v4M5 7h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
                  <span className="hk-pill">=</span>
        </button>
        <button className="toolbar-btn" onClick={handleZoomOut} title="Zoom Out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M5 7h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
                  <span className="hk-pill">−</span>
        </button>
        <button className="toolbar-btn" onClick={handleFitView} title="Fit View">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
                  <span className="hk-pill">0</span>
        </button>

        {/* Print — exports the board as JPEG or PDF by building an SVG
            directly from state (see exportSvg.js), then rasterising it. */}
        <div style={{ position: 'relative' }}>
          <button
            id="print-btn"
            className={`toolbar-btn${printMenuOpen ? ' tool-active' : ''}`}
            onClick={() => setPrintMenuOpen((v) => !v)}
            title="Print / Export"
            disabled={printBusy}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 5V2h8v3M4 11H2V6h12v5h-2M4 9h8v5H4z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {printMenuOpen && (
            <div id="print-menu" style={{
              position: 'absolute', top: '50%', right: 'calc(100% + 8px)',
              transform: 'translateY(-50%)',
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: 6,
              background: 'rgba(20, 22, 30, 0.98)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
              zIndex: 200,
              minWidth: 100,
            }}>
              <button
                onClick={() => exportCanvas('jpeg')}
                style={{ padding: '6px 12px', font: '600 12px ui-sans-serif, system-ui, sans-serif',
                         color: '#e0e0e8', borderRadius: 4, textAlign: 'left', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                JPEG
              </button>
              <button
                onClick={() => exportCanvas('pdf')}
                style={{ padding: '6px 12px', font: '600 12px ui-sans-serif, system-ui, sans-serif',
                         color: '#e0e0e8', borderRadius: 4, textAlign: 'left', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                PDF
              </button>
            </div>
          )}
        </div>

        {/* Print whole board — rasterises the ENTIRE board at world scale, so
            every node's text stays crisp and visible however far out you're
            zoomed. Lossless PNG. */}
        <button
          className="toolbar-btn"
          onClick={() => exportCanvas('png', { whole: true })}
          title="Print whole board — full quality, all text visible"
          disabled={printBusy}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5 6.5h6M5 9.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>

        {/* Page setup — infinite board, or a document made of sheets. */}
        <div style={{ position: 'relative' }}>
          <button
            id="page-btn"
            className={`toolbar-btn${pageMenuOpen || state.doc ? ' tool-active' : ''}`}
            onClick={() => setPageMenuOpen((v) => !v)}
            title="Page setup — infinite board or sheets"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M9 1.8V5h3.5M6 8.2h4.5M6 10.6h4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {pageMenuOpen && (
            <div id="page-menu" className="page-menu">
              <div>
                <span className="props-label">Board</span>
                <div className="seg-row">
                  <button className={`seg-btn${!state.doc ? ' active' : ''}`} onClick={() => changeDoc(null)}>Infinite</button>
                  <button className={`seg-btn${state.doc ? ' active' : ''}`} onClick={() => { if (!state.doc) changeDoc({}); }}>Sheets</button>
                </div>
              </div>
              {!state.doc && pdf && (
                <div className="seg-row">
                  <button className="seg-btn" onClick={() => { setPageMenuOpen(false); pickFiles('application/pdf'); }}>Import PDF…</button>
                </div>
              )}
              {state.doc && (
                <>
                  <div>
                    <span className="props-label">Paper</span>
                    <div className="seg-row">
                      {Object.entries(PAPERS).map(([key, def]) => (
                        <button key={key} className={`seg-btn${state.doc.paper === key ? ' active' : ''}`} onClick={() => changeDoc({ paper: key })}>{def.label}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="props-label">Ruling</span>
                    <div className="seg-row">
                      {PAGE_BGS.map((bg) => (
                        <button key={bg} className={`seg-btn${state.doc.bg === bg ? ' active' : ''}`} onClick={() => changeDoc({ bg })}>{bg[0].toUpperCase() + bg.slice(1)}</button>
                      ))}
                    </div>
                  </div>
                  <div className="seg-row">
                    <button className="seg-btn" onClick={() => { setPagesOpen(true); setPageMenuOpen(false); }}>Pages…</button>
                    {pdf && <button className="seg-btn" onClick={() => { setPageMenuOpen(false); pickFiles('application/pdf'); }}>Import PDF…</button>}
                  </div>
                  <span className="props-label" style={{ opacity: 0.7, textTransform: 'none', letterSpacing: 0 }}>
                    {layout ? `${layout.count} sheet${layout.count === 1 ? '' : 's'} — a new one appears as you fill the last. PDF export is one page per sheet.` : ''}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Duplicate the selection (⌘C then ⌘V does the same) */}
        <button
          className="toolbar-btn"
          onClick={duplicateSelection}
          disabled={!selectedId && selection.nodeIds.size + selection.strokeIds.size + selection.arrowIds.size + (selection.regionIds ? selection.regionIds.size : 0) === 0}
          title="Duplicate selection (⌘C, ⌘V)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5.5 13.5h6.5a1.5 1.5 0 0 0 1.5-1.5V5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M6.5 5v3M5 6.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>

        {/* Delete the selection (the Delete key does the same) */}
        <button
          className="toolbar-btn"
          onClick={deleteAnySelection}
          disabled={!selectedId && selection.nodeIds.size + selection.strokeIds.size + selection.arrowIds.size + (selection.regionIds ? selection.regionIds.size : 0) === 0}
          title="Delete selection (Delete)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3M6.8 7v4M9.2 7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="toolbar-divider" />
        {/* Text ⇄ board: the DSL is the board as text (and what an AI reads/writes). */}
        <button className="toolbar-btn" onClick={() => setDslOpen(true)} title="Import from text (DSL) — ⌘⇧U">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 3.5h10M3 6.5h6M3 9.5h8M3 12.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M11.5 9.5v4M9.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button className="toolbar-btn" onClick={copyDsl} title="Copy board as text (DSL) — ⌘⇧X">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="8" height="8.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className={`toolbar-btn${sourceMode ? ' tool-active' : ''}`}
          onClick={toggleSourceMode}
          title={sourceMode ? 'Show rendered text' : 'Show source (Markdown / LaTeX)'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M5 3L1 8l4 5M11 3l4 5-4 5M9 2l-2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Light / dark theme toggle (negative-effect filter on the body) */}
        <button
          className={`toolbar-btn${lightTheme ? ' tool-active' : ''}`}
          onClick={toggleLightTheme}
          title={lightTheme ? 'Switch to dark theme' : 'Switch to light theme'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 2.5 V 13.5 A 5.5 5.5 0 0 1 8 2.5 Z" fill="currentColor" />
          </svg>
        </button>
      </div>

      {/* Bulk properties panel — shown when 2+ objects are multi-selected */}
      {(() => {
        const items = bulkSelected();
        const inkIds = selection.strokeIds;
        // A popup next to the selection, opened by clicking the selected
        // objects. (Phones keep the docked panel: no room for a popup.)
        if (items.length < 2 && inkIds.size === 0) return null;
        if (isMobile ? (!propsOpen || toolMode === 'draw') : !selPopup) return null;
        const nodeCount = items.filter((i) => i.type === 'node').length;
        const firstInk = inkIds.size ? strokes.find((st) => inkIds.has(st.id)) : null;
        return (
          <div ref={selPopupRef} className={`props-panel compact${openProp ? ' has-open' : ''}${isMobile ? '' : ' sel-popup'}`}>
            <div className="props-title">{items.length + inkIds.size} selected</div>
            <div className="props-group">
              <div className="seg-row">
                <button className="seg-btn" onClick={duplicateSelection} title="Duplicate">Duplicate</button>
                <button className="seg-btn" onClick={copySelection} title="Copy (⌘C)">Copy</button>
                <button className="seg-btn" onClick={deleteAnySelection} title="Delete">Delete</button>
              </div>
              {strokes.some((st) => inkIds.has(st.id) && st.text) && (
                <div className="seg-row" style={{ marginTop: 4 }}>
                  <button className="seg-btn" onClick={copySelectedText} title="Copy the highlighted words">Copy text</button>
                </div>
              )}
            </div>
            {firstInk && (
              <><PropRow id="inkw" label="ink width" value={Math.round((firstInk.width || 2) * 10) / 10} open={openProp} setOpen={setOpenProp}>
                <input
                  type="range" min="0.5" max="10" step="0.5" value={Math.min(10, Math.max(0.5, Math.round((firstInk.width || 2) * 2) / 2))}
                  onChange={(e) => bulkSetStroke({ width: Number(e.target.value) }, false)}
                  onMouseUp={() => bulkSetStroke({}, true)} onTouchEnd={() => bulkSetStroke({}, true)}
                />
</PropRow>
<PropRow id="inko" label="ink opacity" value={`${firstInk.opacity == null ? 100 : firstInk.opacity}%`} open={openProp} setOpen={setOpenProp}>
                <input
                  type="range" min="1" max="100" step="1" value={firstInk.opacity == null ? 100 : firstInk.opacity}
                  onChange={(e) => bulkSetStroke({ opacity: Number(e.target.value) }, false)}
                  onMouseUp={() => bulkSetStroke({}, true)} onTouchEnd={() => bulkSetStroke({}, true)}
                />
              </PropRow></>
            )}
            <PropRow id="bcolor" label="color" value={'set for all…'} open={openProp} setOpen={setOpenProp}>
              <div className="color-palette">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    className="color-swatch"
                    style={{ background: c }}
                    onClick={() => bulkSetColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </PropRow>
            {nodeCount > 0 && (
              <PropRow id="btype" label="type" value={`${nodeCount} node${nodeCount === 1 ? '' : 's'}…`} open={openProp} setOpen={setOpenProp}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                  <button className="logic-chip" onClick={() => bulkSetKind(null)} title="Clear type">none</button>
                  {Object.keys(NODE_KINDS).map((k) => {
                    const def = NODE_KINDS[k];
                    return (
                      <button
                        key={k}
                        className="logic-chip"
                        style={{ borderColor: def.accent, color: def.accent }}
                        onClick={() => bulkSetKind(k)}
                        title={def.label}
                      >{def.label}</button>
                    );
                  })}
                </div>
              </PropRow>
            )}
          </div>
        );
      })()}

      {/* Object properties panel (left) — type, color, text/figure props, arrow props */}
      {(() => {
        const sel = selectedId && selectedType === 'node' ? nodes[selectedId]
                  : selectedId && selectedType === 'arrow' ? arrows[selectedId]
                  : selectedId && selectedType === 'region' ? regions[selectedId]
                  : null;
        if (!sel || !propsOpen || toolMode === 'draw') return null;
        const isNode = selectedType === 'node';
        const isArrow = selectedType === 'arrow';
        const isRegion = selectedType === 'region';
        const isFigure = isNode && !!sel.shape;
        const isTextNode = isNode && sel.style === 'text';
        const arrowKindDef = isArrow && sel.kind ? EDGE_KINDS[sel.kind] : null;
        const colorLocked = (isNode && sel.kind) || (isArrow && !!arrowKindDef);
        const curColor = isArrow ? (arrowKindDef ? arrowKindDef.stroke : (sel.color || '#cf7bf0'))
                       : (isNode && sel.kind ? NODE_KINDS[sel.kind].accent : (sel.color || '#cf7bf0'));
        // Effective arrow direction (operators lock it).
        const dirLocked = isArrow && arrowKindDef && arrowKindDef.render === 'text';
        const curDir = dirLocked
          ? (arrowKindDef.arrows || 'forward')
          : (sel.direction || (sel.bidirectional ? 'both' : (arrowKindDef ? (arrowKindDef.arrows || 'forward') : 'forward')));
        const currentKind = sel.kind;
        const nodeChip = (k) => {
          const def = NODE_KINDS[k];
          const active = currentKind === k;
          return (
            <button
              key={k}
              className={`logic-chip${active ? ' active' : ''}`}
              style={{ borderColor: def.accent, color: active ? '#fff' : def.accent, background: active ? def.bg : 'transparent' }}
              onClick={() => onUpdateNode(selectedId, { kind: k })}
              title={def.label}
            >{def.label}{NODE_KIND_HK[k] && <span className="hk-pill hk-chip">{NODE_KIND_HK[k]}</span>}</button>
          );
        };
        const arrowChip = (k) => {
          const def = EDGE_KINDS[k];
          const active = currentKind === k;
          const chipContent = def.render === 'text' ? def.text : def.label;
          return (
            <button
              key={k}
              className={`logic-chip${active ? ' active' : ''}${def.render === 'text' ? ' op-chip' : ''}`}
              style={{ borderColor: def.stroke, color: active ? '#fff' : def.stroke, background: active ? `${def.stroke}22` : 'transparent' }}
              onClick={() => {
                if (tryMergeIntoOperatorGroup(selectedId, k)) return;
                onUpdateArrow(selectedId, { kind: k });
              }}
              title={def.label}
            >{chipContent}{ARROW_KIND_HK[k] && <span className="hk-pill hk-chip">{ARROW_KIND_HK[k]}</span>}</button>
          );
        };
        return (
          <div className={`props-panel compact${openProp ? ' has-open' : ''}`}>
            <div className="props-title">{selectedType}</div>
            <div className="seg-row" style={{ padding: '0 2px 4px' }}>
              <button className="seg-btn" onMouseDown={(e) => e.preventDefault()} onClick={duplicateSelection} title="Duplicate">Duplicate</button>
              <button className="seg-btn" onMouseDown={(e) => e.preventDefault()} onClick={deleteAnySelection} title="Delete (Delete key)">Delete</button>
            </div>

            {/* Color (text color for text nodes) */}
            <PropRow id="color" label="color" value={<ColorVal c={curColor} locked={colorLocked} />} open={openProp} setOpen={setOpenProp}>
              <div className={`color-palette${colorLocked ? ' disabled' : ''}`}>
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    className={`color-swatch${curColor === c ? ' active' : ''}`}
                    style={{ background: c }}
                    onClick={() => { if (!colorLocked) handleColorChange(c); }}
                    disabled={colorLocked}
                    title={colorLocked ? 'Color is set by type' : (COLOR_HK[c] ? `${c} (⇧${COLOR_HK[c]})` : c)}
                  >{COLOR_HK[c] && <span className="hk-pill hk-swatch">{COLOR_HK[c]}</span>}</button>
                ))}
              </div>
            </PropRow>

            {/* Type (logic kind) — not for text nodes (they're plain labels). */}
            {!isTextNode && !isRegion && (
              <PropRow id="type" label="type" value={currentKind ? ((isArrow ? EDGE_KINDS[currentKind] : NODE_KINDS[currentKind]) || {}).label || currentKind : 'none'} open={openProp} setOpen={setOpenProp}>
                {isNode && (
                  <>
                    <button
                      className={`logic-chip none full${!currentKind ? ' active' : ''}`}
                      onClick={() => onUpdateNode(selectedId, { kind: null })}
                      title="No type"
                    >None<span className="hk-pill hk-chip">⇧N</span></button>
                    {LOGIC_NODE_ROWS.map((row, i) => (
                      <div key={i} className="logic-grid-row">{row.map(nodeChip)}</div>
                    ))}
                  </>
                )}
                {isArrow && (
                  <>
                    <button
                      className={`logic-chip none full${!currentKind ? ' active' : ''}`}
                      onClick={() => onUpdateArrow(selectedId, { kind: null })}
                      title="No type"
                    >None<span className="hk-pill hk-chip">⌘⇧N</span></button>
                    <span className="props-sublabel">Math logic</span>
                    {LOGIC_ARROW_ROWS_MATH.map((row, i) => (
                      <div key={`m${i}`} className="logic-grid-row">{row.map(arrowChip)}</div>
                    ))}
                    <span className="props-sublabel">Reality</span>
                    {LOGIC_ARROW_ROWS_REAL.map((row, i) => (
                      <div key={`r${i}`} className="logic-grid-row">{row.map(arrowChip)}</div>
                    ))}
                  </>
                )}
              </PropRow>
            )}

            {/* Node: toggles (rounded / NOT / probability) */}
            {isNode && !isTextNode && (
              <PropRow id="node" label="node" value={[sel.negated && 'not', sel.probability != null && `prb ${sel.probability}%`].filter(Boolean).join(', ') || 'none'} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  <button
                    className={`props-btn${sel.negated ? ' active' : ''}`}
                    onClick={() => onUpdateNode(selectedId, { negated: !sel.negated })}
                    title="Negate this node (NOT)"
                  >¬ NOT</button>
                  <button
                    className={`props-btn${sel.probability != null ? ' active' : ''}`}
                    onClick={() => onUpdateNode(selectedId, { probability: sel.probability != null ? null : 50 })}
                    title="Toggle probability (0–100%)"
                  >% Prob</button>
                </div>
              </PropRow>
            )}

            {/* Status (epistemic state) — claim nodes only. */}
            {isNode && !isTextNode && (
              <PropRow id="status" label="status" value={sel.status ? NODE_STATUSES[sel.status].label : 'none'} open={openProp} setOpen={setOpenProp}>
                <button
                  className={`logic-chip none full${!sel.status ? ' active' : ''}`}
                  onClick={() => onUpdateNode(selectedId, { status: null })}
                  title="No status"
                >None</button>
                {NODE_STATUS_ROWS.map((row, i) => (
                  <div key={i} className="logic-grid-row">
                    {row.map((s) => {
                      const def = NODE_STATUSES[s];
                      const active = sel.status === s;
                      return (
                        <button
                          key={s}
                          className={`logic-chip${active ? ' active' : ''}`}
                          style={{ borderColor: def.color, color: active ? '#fff' : def.color, background: active ? `${def.color}22` : 'transparent' }}
                          onClick={() => onUpdateNode(selectedId, { status: s })}
                          title={def.label}
                        >{def.label}</button>
                      );
                    })}
                  </div>
                ))}
              </PropRow>
            )}

            {/* Region: lock */}
            {isRegion && (
              <PropRow id="region" label="region" value={sel.fill ? 'filled' : 'outline'} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  <button
                    className={`props-btn${sel.fill ? ' active' : ''}`}
                    onClick={() => onUpdateRegion(selectedId, { fill: !sel.fill })}
                    title="Fill — tint the inside with the region colour (default: outline only)"
                  >{sel.fill ? '▣ Filled' : '▢ Fill'}</button>
                </div>
                {renderRegionExtras && renderRegionExtras(selectedId)}
              </PropRow>
            )}

            {/* Node: alignment */}
            {isNode && !isFigure && (
              <><PropRow id="align" label="align" value={sel.align || 'left'} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  {['left', 'center', 'right'].map(align => (
                    <button
                      key={align}
                      className={`props-btn${(sel.align || 'left') === align ? ' active' : ''}`}
                      onClick={() => onUpdateNode(selectedId, { align })}
                      title={`Align ${align}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        {align === 'left' && <path d="M2 3h12M2 7h8M2 11h10M2 15h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                        {align === 'center' && <path d="M2 3h12M4 7h8M3 11h10M5 15h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                        {align === 'right' && <path d="M2 3h12M6 7h8M4 11h10M8 15h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                      </svg>
                    </button>
                  ))}
                </div>
</PropRow>
<PropRow id="valign" label="v-align" value={sel.valign || 'top'} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  {['top', 'center', 'bottom'].map(valign => (
                    <button
                      key={valign}
                      className={`props-btn${(sel.valign || 'top') === valign ? ' active' : ''}`}
                      onClick={() => onUpdateNode(selectedId, { valign })}
                      title={`Vertical ${valign}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        {valign === 'top' && <path d="M3 2h10M5 6h6M5 9h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                        {valign === 'center' && <path d="M5 4h6M3 8h10M5 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                        {valign === 'bottom' && <path d="M5 7h6M5 10h6M3 14h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                      </svg>
                    </button>
                  ))}
                </div>
              </PropRow></>
            )}

            {/* Node: Markdown formatting toolbar */}
            {isNode && (() => {
              const FMT_ROWS = [
                // Headings
                [
                  { t: 'h1', label: 'H1', title: 'Heading 1' },
                  { t: 'h2', label: 'H2', title: 'Heading 2' },
                  { t: 'h3', label: 'H3', title: 'Heading 3' },
                  { t: 'h4', label: 'H4', title: 'Heading 4' },
                  { t: 'h5', label: 'H5', title: 'Heading 5' },
                  { t: 'h6', label: 'H6', title: 'Heading 6' },
                ],
                // Inline styles
                [
                  { t: 'bold', label: <b>B</b>, title: 'Bold' },
                  { t: 'italic', label: <i>I</i>, title: 'Italic' },
                  { t: 'bolditalic', label: <span><b><i>BI</i></b></span>, title: 'Bold + Italic' },
                  { t: 'strike', label: <span style={{ textDecoration: 'line-through' }}>S</span>, title: 'Strikethrough' },
                  { t: 'underline', label: <span style={{ textDecoration: 'underline' }}>U</span>, title: 'Underline' },
                  { t: 'highlight', label: <span style={{ background: 'rgba(255,213,79,0.45)', padding: '0 3px', borderRadius: 3 }}>H</span>, title: 'Highlight (click for color)', special: 'highlight' },
                ],
                // Sup / sub / block / quote / link
                [
                  { t: 'sup', label: <span>X<sup>2</sup></span>, title: 'Superscript' },
                  { t: 'sub', label: <span>X<sub>2</sub></span>, title: 'Subscript' },
                  { t: 'codeblock', label: <span style={{ fontFamily: 'ui-monospace, monospace' }}>{'</>'}</span>, title: 'Code block' },
                  { t: 'quote', label: '❝', title: 'Quote' },
                  { t: 'link', label: '🔗', title: 'Link' },
                ],
                // Lists
                [
                  { t: 'ul', label: '•', title: 'Bullet list' },
                  { t: 'ol', label: '1.', title: 'Numbered list' },
                  { t: 'task', label: '☑', title: 'ToDo list' },
                ],
              ];
              const HL_COLORS = ['#ffd54f', '#ffb56b', '#ff8aa1', '#cf7bf0', '#8be0a8', '#5bb8ff'];
              return (
                <PropRow id="format" label="format" value={'B · I · H1 · list…'} open={openProp} setOpen={setOpenProp}>
                  {FMT_ROWS.map((row, ri) => (
                    <div key={ri} className="props-row props-format">
                      {row.map(({ t, label, title, special }) => (
                        <button
                          key={t}
                          className={`props-btn fmt${special === 'highlight' && highlightOpen ? ' active' : ''}`}
                          title={title}
                          // Keep the node's text editor focused so the selection
                          // survives the click and execCommand can wrap it.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            if (special === 'highlight') setHighlightOpen((v) => !v);
                            else applyFormat(t);
                          }}
                        >{label}</button>
                      ))}
                    </div>
                  ))}
                  {highlightOpen && (
                    <div className="props-row props-format hl-row">
                      {HL_COLORS.map((c) => (
                        <button
                          key={c}
                          className="props-btn fmt hl-swatch"
                          style={{ background: c }}
                          title={`Highlight ${c}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { applyFormat('highlight', c); setHighlightOpen(false); }}
                        />
                      ))}
                    </div>
                  )}
                </PropRow>
              );
            })()}

            {/* Node: font family + size */}
            {isNode && (
              <><PropRow id="font" label="font" value={FONT_FAMILY_LABEL[sel.fontFamily || 'sans']} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  {FONT_FAMILY_ORDER.map((f) => (
                    <button
                      key={f}
                      className={`props-btn${(sel.fontFamily || 'sans') === f ? ' active' : ''}`}
                      onClick={() => onUpdateNode(selectedId, { fontFamily: f })}
                      title={FONT_FAMILY_LABEL[f]}
                    >{FONT_FAMILY_LABEL[f]}</button>
                  ))}
                </div>
</PropRow>
<PropRow id="size" label="size" value={({ 12: 'S', 14: 'M', 18: 'L', 24: 'XL' })[sel.fontSize || DEFAULT_FONT_SIZE] || `${sel.fontSize}px`} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  {[
                    { k: 'S', px: 12 },
                    { k: 'M', px: 14 },
                    { k: 'L', px: 18 },
                    { k: 'XL', px: 24 },
                  ].map(({ k, px }) => (
                    <button
                      key={k}
                      className={`props-btn${(sel.fontSize || DEFAULT_FONT_SIZE) === px ? ' active' : ''}`}
                      onClick={() => onUpdateNode(selectedId, { fontSize: px })}
                      title={`${k} (${px}px)`}
                    >{k}</button>
                  ))}
                </div>
              </PropRow></>
            )}

            {/* Operator pill: negate the whole sub-formula; linear formula */}
            {isArrow && arrowKindDef && arrowKindDef.render === 'text' && (
              <PropRow id="subformula" label="formula" value={sel.negated ? 'not' : 'none'} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  <button
                    className={`props-btn${sel.negated ? ' active' : ''}`}
                    onClick={() => onUpdateArrow(selectedId, { negated: !sel.negated })}
                    title="Negate this sub-formula: ¬( … )  (⌘⇧1)"
                  >¬ NOT</button>
                </div>
              </PropRow>
            )}

            {/* Arrow: direction */}
            {isArrow && (
              <PropRow id="direction" label="direction" value={({ forward: '→', reverse: '←', both: '↔', none: '—' })[curDir] + (dirLocked ? ' (by type)' : '')} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  {[
                    { d: 'forward', s: '→' },
                    { d: 'reverse', s: '←' },
                    { d: 'both', s: '↔' },
                    { d: 'none', s: '—' },
                  ].map(({ d, s }) => (
                    <button
                      key={d}
                      className={`props-btn${curDir === d ? ' active' : ''}`}
                      disabled={dirLocked}
                      onClick={() => onUpdateArrow(selectedId, { direction: d, bidirectional: false })}
                      title={d}
                    >{s}</button>
                  ))}
                </div>
              </PropRow>
            )}

            {/* Arrow: label text */}
            {isArrow && (
              <PropRow id="label" label="label" value={sel.label || 'none'} open={openProp} setOpen={setOpenProp}>
                <input
                  className="props-input"
                  type="text"
                  value={sel.label || ''}
                  placeholder="Arrow label…"
                  onChange={(e) => onUpdateArrow(selectedId, { label: e.target.value })}
                />
              </PropRow>
            )}

            {/* Arrow: dash style */}
            {isArrow && (
              <PropRow id="line" label="line" value={['solid', 'dashed', 'long dashes'][sel.dash || 0]} open={openProp} setOpen={setOpenProp}>
                <div className="props-row">
                  {[0, 1, 2].map((d) => (
                    <button
                      key={d}
                      className={`props-btn${(sel.dash || 0) === d ? ' active' : ''}`}
                      onClick={() => onUpdateArrow(selectedId, { dash: d })}
                      title={d === 0 ? 'Solid' : d === 1 ? 'Dashed' : 'Long dashes'}
                    >
                      <svg width="34" height="10" viewBox="0 0 34 10">
                        <line x1="2" y1="5" x2="32" y2="5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                          strokeDasharray={d === 1 ? '6 4' : d === 2 ? '11 6' : undefined} />
                      </svg>
                    </button>
                  ))}
                </div>
              </PropRow>
            )}

            {/* Arrow: shape (curve / elbow) + edit handles */}
            {isArrow && (() => {
              const isElbow = sel.line === 'elbow' || sel.line === 'straight';
              return (
                <PropRow id="shape" label="shape" value={(isElbow ? 'elbow' : 'curve') + (showArrowHandles && !isElbow ? ', handles' : '')} open={openProp} setOpen={setOpenProp}>
                  <div className="props-row">
                    <button
                      className={`props-btn${!isElbow ? ' active' : ''}`}
                      onClick={() => onUpdateArrow(selectedId, { line: 'curve' })}
                      title="Curved"
                    >Curve</button>
                    <button
                      className={`props-btn${isElbow ? ' active' : ''}`}
                      onClick={() => onUpdateArrow(selectedId, { line: 'elbow' })}
                      title="Elbow (orthogonal)"
                    >Elbow</button>
                    <button
                      className={`props-btn${showArrowHandles ? ' active' : ''}`}
                      disabled={isElbow}
                      onClick={() => setShowArrowHandles((v) => !v)}
                      title="Show bezier control handles"
                    >Handles</button>
                  </div>
                </PropRow>
              );
            })()}
          </div>
        );
      })()}

      {/* Canvas */}
      <Canvas
        nodes={nodes}
        arrows={arrows}
        viewport={viewport}
        selectedId={selectedId}
        selectedType={selectedType}
        onUpdateViewport={onUpdateViewport}
        onAddNode={onAddNode}
        onUpdateNode={onUpdateNode}
        onAddArrow={onAddArrow}
        onSelect={onSelect}
        toolMode={toolMode}
        drawColor={drawColor}
        drawWidth={drawWidth}
        drawOpacity={drawOpacity}
        drawFlat={penKind === 'highlighter'}
        drawStraight={penKind === 'highlighter' && hlStraight}
        textSnap={penKind === 'highlighter' && hlText && !!pdf}
        onAddStrokes={onAddStrokes}
        eraserTarget={eraserTarget}
        assets={assets}
        pdf={pdf}
        onAddSpace={onAddSpace}
        onPlaceObject={onPlaceObject}
        figureShape={figureShape}
        drawStrokes={strokes}
        onAddStroke={onAddStroke}
        eraserMode={eraserMode}
        eraserRadius={eraserRadius}
        onEraseObjects={onEraseObjects}
        onPixelErase={onPixelErase}
        onEraseEnd={onEraseEnd}
        selection={selection}
        onSelectionChange={onSelectionChange}
        onToggleSelect={onToggleSelect}
        onMoveSelection={onMoveSelection}
        onSelectionDragEnd={onSelectionDragEnd}
        onNodeDragEnd={onNodeDragEnd}
        isMobile={isMobile}
        onUpdateArrow={onUpdateArrow}
        onUpdateArrowLive={onUpdateArrowLive}
        showArrowHandles={showArrowHandles}
        sourceMode={sourceMode}
        regions={regions}
        onUpdateRegion={onUpdateRegion}
        onUpdateStroke={onUpdateStroke}
        onRegionDragEnd={onRegionDragEnd}
        editingNodeId={editingNodeId}
        setEditingNodeId={setEditingNodeId}
        mode={mode}
        kbArrowDrag={kbArrowDrag}
        kbNudgeApiRef={kbNudgeApiRef}
        docLayout={layout}
        onAltDuplicate={onAltDuplicate}
        onLassoEnd={onLassoEnd}
        onTwoFingerTap={undo}
        onThreeFingerTap={redo}
        onDoubleTap={onDoubleTap}
        selectFree={selectKind === 'lasso'}
        onFingerLongPress={onFingerLongPress}
        penOnly={penOnly}
        onPenSeen={onPenSeen}
        onSelectionTap={setSelPopup}
        noteFor={(id) => notes[id] || null}
        onOpenNote={onOpenNote}
      />

      {!propsOpen && (
        <button className="toolbar-btn props-toggle" onClick={() => setPropsOpen(true)} title="Show settings (`)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="hk-pill">`</span>
        </button>
      )}
      {layout && (
        <div className={`page-chip${pagesOpen ? ' open' : ''}`}>
          <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 0} title="Previous page">‹</button>
          <button className="page-chip-num" onClick={() => setPagesOpen((v) => !v)} title="Pages — thumbnails, add, reorder, delete">
            {currentPage + 1} / {layout.count}
          </button>
          <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= layout.count - 1} title="Next page">›</button>
        </div>
      )}
      {layout && pagesOpen && (
        <PagePanel
          state={state} layout={layout} pdf={pdf} light={false} current={currentPage}
          onGo={goToPage} onInsert={onInsertPage} onDuplicate={onDuplicatePage} onMove={onMovePage} onDelete={onDeletePage}
          onImport={pdf ? () => pickFiles('application/pdf') : null}
          onExportHighlights={exportHighlights}
          onClose={() => setPagesOpen(false)}
        />
      )}
      <ModeBadge mode={mode} />
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
      {dslOpen && <DslModal onClose={() => setDslOpen(false)} onImport={onImportDsl} />}
    </div>
  );
}

// One line of the properties panel: `name: current value`. Clicking it unfolds
// the choices for that property (one property open at a time).
function PropRow({ id, label, value, open, setOpen, children }) {
  const isOpen = open === id;
  return (
    <div className={`props-group prop${isOpen ? ' open' : ''}`}>
      <button
        className="prop-row"
        // Keep a node's text editor focused (the format buttons act on its selection).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(isOpen ? null : id)}
        title={isOpen ? 'Collapse' : 'Show options'}
      >
        <span className="prop-key">{label}</span>
        <span className="prop-val">{value}</span>
        <span className="prop-caret">{isOpen ? '▾' : '▸'}</span>
      </button>
      {isOpen && <div className="prop-body">{children}</div>}
    </div>
  );
}

const COLOR_NAMES = {
  '#868e96': 'grey', '#ff6b6b': 'red', '#ffa94d': 'orange', '#ffd43b': 'yellow', '#69db7c': 'green',
  '#38d9a9': 'teal', '#4dabf7': 'blue', '#cf7bf0': 'purple', '#f783ac': 'pink', '#ffffff': 'white',
};
function ColorVal({ c, locked }) {
  return <><span className="prop-dot" style={{ background: c }} />{locked ? 'set by type' : (COLOR_NAMES[String(c).toLowerCase()] || c)}</>;
}

// Small overlay in the corner showing the active Vim-mode.
function ModeBadge({ mode }) {
  return (
    <div className={`mode-badge mode-${mode}`}>
      {mode === 'dev' ? 'DEV' : 'EDIT'}
    </div>
  );
}

// Full keyboard cheat-sheet, toggled with `?`.
const SHORTCUT_SECTIONS = [
  { title: 'Tools (digits)', rows: [
    ['1', 'Select (again: rectangle ⇄ lasso)'], ['2', 'Pen'], ['3', 'Highlighter'],
    ['4', 'Eraser'], ['5', 'Text'], ['7', 'Arrow tool'], ['H', 'Move / pan (hand)'],
    ['6 → Space', 'arm Node, then Space to drop one'],
    ['8 → Space', 'arm Region'],
    ['9 then 1–5', 'arm Figure: 1 rect · 2 square · 3 circle · 4 ellipse · 5 triangle → Space'],
  ]},
  { title: 'Touch & stylus', rows: [
    ['Stylus', 'draws / erases / selects with the current tool (pressure-sensitive)'],
    ['1 finger', 'pan · tap to select · drag an object to move it'],
    ['2 fingers', 'pinch to zoom, drag to pan'],
    ['Double tap', 'eraser ⇄ last tool'],
    ['2-finger tap / 3-finger tap', 'undo / redo'],
    ['Long press', 'pen options (colour, width, opacity)'],
  ]},
  { title: 'Modes (Vim-style)', rows: [
    ['Enter', 'dev ⇄ edit (edits the selected node)'],
    ['i', 'enter edit'],
    ['Esc', 'exit edit / clear selection'],
    ['Tab', 'next node'],
  ]},
  { title: 'Build & connect (dev)', rows: [
    ['I / J / K / L', 'new connected node up / left / down / right (→ edit)'],
    ['W A S D', 'move selected node'],
    ['⌘ + W A S D', 'jump to the nearest node or arrow in that direction'],
    ['. + W A S D', 'jump to the nearest arrow'],
    ['⌘ F', 'centre the view on the selected node / arrow'],
    ['← ↑ ↓ →', 'move selected node 1 cell (Shift = 5)'],
  ]},
  { title: 'Create & size (dev)', rows: [
    ['N', 'new node at centre → edit'],
    ['`', 'toggle properties panel'],
    ['⌥ + W/S', 'node: bottom edge up / down'],
    ['⌥ + A/D', 'node: right edge left / right'],
  ]},
  { title: 'Node type — Shift + key (dev)', rows: [
    ['D def · P postulate · U assumption · B belief', ''],
    ['T thesis · F fact · O objection · R response', ''],
    ['Q question · C conclusion · S source', ''],
    ['⌘: A axiom · P premise · S scope · N none', ''],
  ]},
  { title: 'Arrow type — Shift + key (dev)', rows: [
    ['A and · O or · X xor · I implies · T therefore · E equivalently', ''],
    ['N necessary · S supports · C contradicts · P presupposes', ''],
    ['R refines · G generalizes · ` analogous · = identical', ''],
    ['⌘: S sufficient · X counter-ex · E example', ''],
    ['Shift+P then − / = : decrease / increase probability', ''],
  ]},
  { title: 'Colour — Shift + digit', rows: [
    ['1 grey · 2 red · 3 orange · 4 yellow · 5 green', ''],
    ['6 teal · 7 blue · 8 purple · 9 pink · 0 white', ''],
    ['⌘+Shift+1 / ⌘+Shift+5', 'toggle NOT / probability on node'],
  ]},
  { title: 'Edit', rows: [
    ['⌘/Ctrl + Z', 'undo'],
    ['⌘/Ctrl + Shift + Z', 'redo'],
    ['Delete / Backspace', 'delete selection'],
    ['⌘C / ⌘X / ⌘V', 'copy / cut / paste objects (with their arrows and ink)'],
    ['⌥ drag', 'drag a copy of the object / selection'],
    ['⇧ while dragging', 'lock to one axis · line ends turn in 15° steps'],
    ['⇧ while drawing', 'straight line from where the stroke began'],
    ['⌘ while dragging', 'ignore the grid magnet (ink and line ends)'],
    ['Draw, then hold still', 'snap a rough line / rectangle / ellipse to the clean shape'],
    ['T / V', 'text align centre ⇄ left / vertical align centre ⇄ top'],
    ['⌃7 ⌃8 ⌃9 ⌃0', 'in edit: insert $\\wedge$ $\\vee$ $\\subset$ $\\supset$'],
    ['⌃. ⌃, ⌃= ⌃`', 'in edit: insert $\\Rightarrow$ $\\Leftarrow$ $\\equiv$ $\\sim$'],
    ['⌘⇧1', 'negate node or operator pill (¬)'],
    ['⌘⇧U', 'import from text (DSL)'],
    ['⌘⇧X', 'copy board / selection as text (DSL)'],
    ['?', 'toggle this sheet'],
  ]},
];

const DSL_EXAMPLE = `# Nodes:  id: [type] "text" [#status]
# Edges:  from -> to [: type] ["label"]

socrates: premise "Socrates is a man"
mortal:   axiom   "All men are mortal"
concl:    conclusion "Socrates is mortal" #accepted

mortal   -> concl : supports
socrates -> concl : supports
doubt:    objection "Is mortality universal?"
doubt    -> mortal : contradicts`;

function DslModal({ onClose, onImport }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null); // { count, errors }
  const run = () => setResult(onImport(text || DSL_EXAMPLE));
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="dsl-card" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <div className="shortcuts-head">
          <span>Import from text — DSL → graph</span>
          <button className="shortcuts-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <textarea
          className="dsl-textarea"
          value={text}
          placeholder={DSL_EXAMPLE}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <div className="dsl-help">
          <code>id: type "text" #status</code> · <code>from -&gt; to : type "label"</code> ·
          arrows <code>-&gt;</code> <code>&lt;-&gt;</code> <code>--</code> <code>=&gt;</code> ·
          types: thesis/premise/… &amp; supports/contradicts/and/or/… · undefined ids auto-create.
        </div>
        {result && (
          <div className="dsl-result">
            {result.count > 0 && <div className="dsl-ok">Added {result.count} node{result.count === 1 ? '' : 's'}.</div>}
            {result.errors.map((er, i) => <div key={i} className="dsl-err">{er}</div>)}
          </div>
        )}
        <div className="dsl-actions">
          <button className="props-btn" onClick={() => setText(DSL_EXAMPLE)}>Load example</button>
          <button className="dsl-generate" onClick={run}>Generate</button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsOverlay({ onClose }) {
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-card" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <span>Keyboard shortcuts</span>
          <button className="shortcuts-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="shortcuts-grid">
          {SHORTCUT_SECTIONS.map((s) => (
            <div key={s.title} className="shortcuts-section">
              <div className="shortcuts-section-title">{s.title}</div>
              {s.rows.map(([k, v], i) => (
                <div key={i} className="shortcuts-row">
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
