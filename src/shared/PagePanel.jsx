import { memo, useEffect, useMemo, useRef, useState } from 'react';
import PageBg from './PageBg.jsx';
import { buildExportSvg } from './exportSvg.js';
import { sliceRect, pageOfY, boxOfStroke } from './pages.js';

const THUMB_W = 96;

// One cheap pass over the board: a fingerprint per page, so a thumbnail is
// rebuilt only when something on ITS page changed.
function pageSignatures(state, layout) {
  const sig = layout.pages.map(() => [0, 0, '']);
  const at = (cy) => sig[Math.min(layout.count - 1, pageOfY(layout, cy))];
  for (const s of state.strokes || []) {
    const b = boxOfStroke(s);
    if (b.y0 === Infinity) continue;
    const e = at((b.y0 + b.y1) / 2);
    e[0] += 1; e[1] += (s.points ? s.points.length : 0) + Math.round(b.x0 + b.y0); e[2] = s.id;
  }
  for (const n of Object.values(state.nodes || {})) {
    const e = at(n.y + (n.height || 60) / 2);
    e[0] += 1; e[1] += Math.round(n.x + n.y + (n.width || 0)) + (n.text ? n.text.length : 0); e[2] = n.id;
  }
  return sig.map((e) => e.join(':'));
}

const PageThumb = memo(function PageThumb({ page, index, getState, light, pdf, active, onPick }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => { if (active && ref.current) ref.current.scrollIntoView({ block: 'nearest' }); }, [active]);
  // Rebuilt when the memo lets a new render through, i.e. the page changed.
  const ink = seen
    ? `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildExportSvg(sliceRect(getState(), page), { rect: page, transparent: true, light }))}")`
    : 'none';
  return (
    <button ref={ref} className={`page-thumb${active ? ' active' : ''}`} onClick={() => onPick(index)} title={`Page ${index + 1}`}>
      <span className="page-thumb-sheet" style={{ width: THUMB_W, height: Math.round((THUMB_W * page.h) / page.w) }}>
        {page.bg && <PageBg bg={page.bg} pdf={pdf} cssWidth={THUMB_W} zoom={1} />}
        <span className="page-thumb-ink" style={{ backgroundImage: ink }} />
      </span>
      <span className="page-thumb-num">{index + 1}</span>
    </button>
  );
}, (a, b) => a.sig === b.sig && a.active === b.active && a.index === b.index && a.page.bg === b.page.bg && a.page.h === b.page.h && a.pdf === b.pdf && a.light === b.light);

const Icon = ({ d }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/**
 * Page strip of a paged document: thumbnails to jump by, and the page
 * operations (add, duplicate, reorder, delete) for the current page.
 */
export default function PagePanel({ state, layout, pdf, light, current, onGo, onInsert, onDuplicate, onMove, onDelete, onImport, onClose }) {
  // Thumbnails read the board when they rebuild, without re-rendering on every edit.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });
  const [getState] = useState(() => () => stateRef.current);
  const sigs = useMemo(
    () => pageSignatures(state, layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.strokes, state.nodes, layout],
  );
  const last = layout.count - 1; // the trailing blank sheet
  return (
    <div className="page-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="page-panel-head">
        <span>Pages</span>
        <button className="page-op" onClick={onClose} title="Close"><Icon d="M4 4l8 8M12 4l-8 8" /></button>
      </div>
      <div className="page-panel-list">
        {layout.pages.map((pg, i) => (
          <PageThumb key={i} page={pg} index={i} sig={sigs[i]} getState={getState} light={light} pdf={pdf} active={i === current} onPick={onGo} />
        ))}
      </div>
      <div className="page-panel-ops">
        <button className="page-op" onClick={() => onInsert(current)} title="New page above this one"><Icon d="M3 9.5h10v4H3zM8 2v5M5.5 4.5h5" /></button>
        <button className="page-op" onClick={() => onInsert(current + 1)} title="New page below this one"><Icon d="M3 2.5h10v4H3zM8 9v5M5.5 11.5h5" /></button>
        <button className="page-op" onClick={() => onDuplicate(current)} disabled={current === last} title="Duplicate this page"><Icon d="M2.5 2.5h8v8h-8zM5.5 13.5H12a1.5 1.5 0 0 0 1.5-1.5V5.5" /></button>
        <button className="page-op" onClick={() => onMove(current, current - 1)} disabled={current === 0 || current === last} title="Move this page up"><Icon d="M8 13V3M4 7l4-4 4 4" /></button>
        <button className="page-op" onClick={() => onMove(current, current + 1)} disabled={current >= last - 1} title="Move this page down"><Icon d="M8 3v10M4 9l4 4 4-4" /></button>
        <button className="page-op danger" onClick={() => onDelete(current)} disabled={current === last} title="Delete this page and everything on it"><Icon d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3" /></button>
      </div>
      {onImport && (
        <button className="page-import" onClick={onImport} title="Add a PDF: each of its pages becomes a sheet you can write on">Import PDF…</button>
      )}
    </div>
  );
}
