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
  return {
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
