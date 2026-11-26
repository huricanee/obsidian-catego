import { useEffect, useRef, useState } from 'react';

const MAX_PX = 2000; // widest bitmap kept per page (memory: ~4 bytes × w × h)

/**
 * One PDF page painted behind a sheet. Rendered lazily — only while the page
 * is on (or near) the screen — at a resolution that follows the zoom, and
 * released again when it scrolls away: a textbook is hundreds of pages.
 */
export default function PageBg({ bg, pdf, cssWidth, zoom = 1, className = '', wantText = false }) {
  const ref = useRef(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const [error, setError] = useState(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Resolution steps (×1.5) so a pinch doesn't re-render on every frame.
  const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
  const want = cssWidth * Math.max(0.2, zoom) * dpr;
  const px = Math.min(MAX_PX, Math.max(160, Math.round(160 * 1.5 ** Math.ceil(Math.log(want / 160) / Math.log(1.5)))));

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!near || !pdf) { el.width = 0; el.height = 0; return undefined; }
    let dead = false;
    pdf.renderPage(bg.src, bg.page, px).then((c) => {
      if (dead) return;
      el.width = c.width; el.height = c.height;
      el.getContext('2d').drawImage(c, 0, 0);
      setError(null);
    }).catch((e) => { if (!dead) setError(String((e && e.message) || e)); });
    return () => { dead = true; };
  }, [near, pdf, bg.src, bg.page, px]);

  // The text layer of pages in view is fetched ahead, so a highlight can
  // snap to the words the moment the pen lands.
  useEffect(() => { if (near && wantText && pdf && pdf.textNow) pdf.textNow(bg.src, bg.page); }, [near, wantText, pdf, bg.src, bg.page]);

  return (
    <>
      <canvas ref={ref} className={`page-bg ${className}`} />
      {(error || !pdf) && <span className="page-bg-missing">{error || `PDF: ${bg.src}`}</span>}
    </>
  );
}

/** An image stored as a board asset (`assets.url(src)` → something an <img> can show). */
export function AssetImg({ src, assets, onSize, ...rest }) {
  const direct = /^(data:|blob:|https?:)/.test(src || '');
  const [found, setFound] = useState({ src: null, url: null });
  useEffect(() => {
    if (direct || !assets || !assets.url) return undefined;
    let dead = false;
    Promise.resolve(assets.url(src)).then((u) => { if (!dead) setFound({ src, url: u || null }); }).catch(() => { if (!dead) setFound({ src, url: null }); });
    return () => { dead = true; };
  }, [src, assets, direct]);
  const url = direct ? src : (found.src === src ? found.url : null);
  if (!url) return <span className="node-image-missing">{src}</span>;
  return <img src={url} alt="" draggable={false} onLoad={onSize ? (e) => onSize(e.target.naturalWidth, e.target.naturalHeight) : undefined} {...rest} />;
}
