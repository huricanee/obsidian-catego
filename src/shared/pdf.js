/**
 * PDF pages as sheet backgrounds. The board never bundles a PDF engine: the
 * host hands one over (`loadPdfJs` → the pdf.js library object — the web app
 * loads pdfjs-dist, Obsidian lends its own), and `assets.data(src)` returns
 * the file's bytes.
 */
export function makePdfService(loadPdfJs, assets) {
  if (!loadPdfJs || !assets || !assets.data) return null;
  const docs = new Map(); // src → Promise<PDFDocumentProxy>
  const getDoc = (src) => {
    let p = docs.get(src);
    if (!p) {
      p = (async () => {
        const [lib, data] = await Promise.all([loadPdfJs(), assets.data(src)]);
        if (!data) throw new Error(`PDF not found: ${src}`);
        // pdf.js takes ownership of the buffer it is given — hand it a copy.
        return lib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
      })();
      p.catch(() => docs.delete(src));
      docs.set(src, p);
    }
    return p;
  };
  // --- text layer (for highlighting the book's own text) -------------------
  const texts = new Map(); // `${src}#${page}` → { value } once loaded
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  let measure = null;
  // Glyph advances are not in the text content: a string's own width is split
  // between its characters in the proportions of a generic serif face.
  const advances = (str) => {
    if (measure === null) {
      try { measure = document.createElement('canvas').getContext('2d'); measure.font = '100px serif'; } catch { measure = false; }
    }
    const out = [];
    let sum = 0;
    for (const ch of str) { const w = measure ? measure.measureText(ch).width || 50 : 50; out.push(w); sum += w; }
    return out.map((w) => w / (sum || 1));
  };
  async function loadText(src, pageNo) {
    const doc = await getDoc(src);
    const page = await doc.getPage(Math.min(doc.numPages, Math.max(1, pageNo)));
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const chars = [];
    let line = 0, lastBase = null, lastH = 0;
    for (const it of content.items) {
      if (typeof it.str !== 'string') continue;
      const tx = mul(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]) || it.height || 10;
      const base = tx[5];
      if (lastBase !== null && Math.abs(base - lastBase) > Math.max(h, lastH) * 0.45) line += 1;
      if (it.str) {
        lastBase = base; lastH = h;
        const adv = advances(it.str);
        let x = tx[4];
        let k = 0;
        for (const ch of it.str) {
          const w = adv[k++] * (it.width || 0);
          chars.push({ c: ch, x0: x, x1: x + w, top: base - h * 0.84, bot: base + h * 0.24, line });
          x += w;
        }
      }
      if (it.hasEOL && chars.length) chars[chars.length - 1].eol = true;
    }
    return { w: vp.width, h: vp.height, chars };
  }

  return {
    /**
     * Text of a page, if it is already loaded: { w, h, chars: [{ c, x0, x1,
     * top, bot, line, eol? }] } in PDF points (top-left origin). Returns null
     * and starts loading otherwise — ask again later.
     */
    textNow(src, pageNo) {
      const key = `${src}#${pageNo}`;
      const hit = texts.get(key);
      if (hit) return hit.value || null;
      const entry = { value: null };
      texts.set(key, entry);
      loadText(src, pageNo).then((v) => { entry.value = v; }).catch(() => { entry.value = { w: 1, h: 1, chars: [] }; });
      return null;
    },
    /** [{ w, h }] of every page, in PDF points. */
    async pageSizes(src) {
      const doc = await getDoc(src);
      const out = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const v = (await doc.getPage(i)).getViewport({ scale: 1 });
        out.push({ w: v.width, h: v.height });
      }
      return out;
    },
    /** Page `pageNo` (1-based) rendered `pxWidth` pixels wide → a new canvas. */
    async renderPage(src, pageNo, pxWidth) {
      const doc = await getDoc(src);
      const page = await doc.getPage(Math.min(doc.numPages, Math.max(1, pageNo)));
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pxWidth / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      return canvas;
    },
  };
}

/* ---- text selection on a PDF sheet (pure geometry) ---------------------- */

/** Sheet rect → how the PDF page sits in it (letterboxed, centred). */
export function pdfPlacement(pg, text) {
  const s = Math.min(pg.w / text.w, pg.h / text.h);
  return { s, ox: pg.x + (pg.w - text.w * s) / 2, oy: pg.y + (pg.h - text.h * s) / 2 };
}

/** Index of the character nearest to a point (PDF points) and its distance. */
export function nearestChar(text, x, y) {
  let best = -1, bestD = Infinity;
  const cs = text.chars;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const dx = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
    const dy = y < c.top ? c.top - y : y > c.bot ? y - c.bot : 0;
    const d = Math.hypot(dx, dy * 2.5); // staying on the line matters more
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, dist: bestD };
}

/** Characters a..b (any order) → { rects: one per line (PDF points), text }. */
export function textRange(text, a, b) {
  const i0 = Math.max(0, Math.min(a, b)), i1 = Math.min(text.chars.length - 1, Math.max(a, b));
  const rects = [];
  let out = '';
  let cur = null;
  for (let i = i0; i <= i1; i++) {
    const c = text.chars[i];
    if (!cur || cur.line !== c.line || c.x0 < cur.x1 - (c.bot - c.top) * 2) {
      cur = { line: c.line, x0: c.x0, x1: c.x1, top: c.top, bot: c.bot };
      rects.push(cur);
    } else {
      cur.x0 = Math.min(cur.x0, c.x0); cur.x1 = Math.max(cur.x1, c.x1);
      cur.top = Math.min(cur.top, c.top); cur.bot = Math.max(cur.bot, c.bot);
    }
    out += c.c;
    if (i < i1 && (c.eol || text.chars[i + 1].line !== c.line)) {
      // A word broken across lines is joined back; otherwise the break is a space.
      if (/[\p{L}]-$/u.test(out) && /^\p{Ll}/u.test(text.chars[i + 1].c)) out = out.slice(0, -1);
      else if (!/\s$/.test(out)) out += ' ';
    }
  }
  return { rects: rects.filter((r) => r.x1 - r.x0 > 0.5), text: out.replace(/\s+/g, ' ').trim() };
}
