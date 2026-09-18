/**
 * Rich-text rendering for node text: Markdown + LaTeX.
 *
 * Markdown is parsed with `marked` (GFM: bold/italic/strikethrough, headings,
 * lists, task lists, links, inline code, code blocks, blockquotes, tables).
 * LaTeX ($...$ / $$...$$) is rendered with KaTeX. The markdown HTML is
 * sanitised with DOMPurify before the (trusted) KaTeX output is injected.
 *
 * Storage stays plain text; the `</>` (source) toggle shows the raw source,
 * everything else shows this rendered HTML — same model as the old LaTeX path.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

marked.setOptions({ gfm: true, breaks: true });

// $$display$$ or $inline$ (inline can't span newlines).
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
// A control char as a placeholder marker — survives markdown + sanitisation as
// inert text and won't collide with anything a user would actually type.
const MARK = String.fromCharCode(1); // U+0001
const RESTORE_RE = new RegExp(MARK + '(\\d+)' + MARK, 'g');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderRichToHtml(text) {
  if (text == null || text === '') return '';

  // 1. Pull math out so markdown can't mangle it.
  const maths = [];
  const protectedText = String(text).replace(MATH_RE, (m, disp, inl) => {
    const idx = maths.length;
    maths.push({ content: disp != null ? disp : inl, display: disp != null });
    return MARK + idx + MARK;
  });

  // 2. Markdown -> HTML.
  let html;
  try { html = marked.parse(protectedText); }
  catch { html = escapeHtml(protectedText); }

  // 3. Sanitise the markdown HTML (user-authored, shared across collaborators).
  html = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });

  // 4. Swap the math markers back for trusted KaTeX output.
  html = html.replace(RESTORE_RE, (m, i) => {
    const seg = maths[Number(i)];
    if (!seg) return '';
    try {
      return katex.renderToString(seg.content, {
        displayMode: seg.display,
        throwOnError: false,
        errorColor: '#ff6b6b',
        strict: false,
      });
    } catch {
      const d = seg.display ? '$$' : '$';
      return `<span style="color:#ff6b6b">${d}${escapeHtml(seg.content)}${d}</span>`;
    }
  });

  return html;
}
