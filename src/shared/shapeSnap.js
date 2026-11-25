/**
 * Draw-and-hold shape snapping: a roughly drawn line, rectangle or ellipse
 * becomes the clean shape; anything else (letters, squiggles) is left alone.
 *
 * The geometry is the open-source `interactive-shape-recognition` package
 * (MIT, Szymon Kaliski) — an implementation of Jorge & Fonseca, "A Simple
 * Approach to Recognise Geometric Shapes Interactively": convex hull, largest
 * inscribed triangle and the ratios between their perimeters / areas. The
 * package's own final verdict is not used (it misses rectangles and ellipses);
 * the decision below applies the paper's ratio tests to the package's features:
 *
 *   thinness  Pch² / Ach   — huge for a line
 *   Len / Pch              — ≈ 0.5 for an open line, ≈ 1 for one closed loop
 *   Alt / Ach              — largest triangle in the hull: ≈ 0.41 ellipse, 0.5 rectangle, 1 triangle
 *   Ach / Aer              — hull vs bounding box: ≈ π/4 ellipse, ≈ 1 rectangle
 */
import detectShape from 'interactive-shape-recognition';
import areaPolygon from 'area-polygon';

const MAX_POINTS = 64; // the package's triangle search is cubic in hull size

function resample(points) {
  if (points.length <= MAX_POINTS) return points;
  const out = [];
  const step = (points.length - 1) / (MAX_POINTS - 1);
  for (let i = 0; i < MAX_POINTS; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function lineShape(a, b) {
  let { x: x2, y: y2 } = b;
  // Nearly horizontal / vertical → exactly so.
  const ang = Math.abs(Math.atan2(y2 - a.y, x2 - a.x) * 180 / Math.PI);
  if (ang < 4 || ang > 176) y2 = a.y;
  else if (Math.abs(ang - 90) < 4) x2 = a.x;
  return { kind: 'line', points: [{ x: a.x, y: a.y }, { x: x2, y: y2 }] };
}

function rectShape(x0, y0, x1, y1) {
  const pts = [];
  const side = (ax, ay, bx, by) => {
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 8));
    for (let i = 0; i < n; i++) pts.push({ x: ax + (bx - ax) * i / n, y: ay + (by - ay) * i / n });
  };
  side(x0, y0, x1, y0); side(x1, y0, x1, y1); side(x1, y1, x0, y1); side(x0, y1, x0, y0);
  pts.push({ x: x0, y: y0 });
  return { kind: 'rect', points: pts };
}

function ellipseShape(x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const n = Math.max(48, Math.min(160, Math.round((rx + ry) * Math.PI / 6)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI - Math.PI / 2;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return { kind: 'ellipse', points: pts };
}

/**
 * @param points [{x, y}] the stroke so far (world units)
 * @param minSize smallest extent worth snapping (world units)
 * @returns null, or { kind: 'line' | 'rect' | 'ellipse', points }
 */
export function recognizeShape(points, minSize = 24) {
  if (!points || points.length < 6) return null;
  const first = points[0], last = points[points.length - 1];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const w = x1 - x0, h = y1 - y0;
  if (Math.max(w, h) < minSize) return null;

  let f;
  try {
    f = detectShape(resample(points).map((p) => [p.x, p.y]));
  } catch {
    return null; // degenerate input (the hull code needs real area)
  }
  const { rThinness: thin, rLenPch: lenPch, rAltAch: alt, hull } = f;
  if (!Number.isFinite(lenPch) || !hull || hull.length < 3) return null;

  // Line: a sliver of a hull, travelled once (no doubling back).
  if ((thin > 55 || !Number.isFinite(thin)) && lenPch < 0.72) return lineShape(first, last);

  // Closed figure: one loop that ends near where it began.
  if (Math.min(w, h) < minSize / 2) return null;
  let hullPerimeter = 0;
  for (let i = 1; i < hull.length; i++) hullPerimeter += Math.hypot(hull[i][0] - hull[i - 1][0], hull[i][1] - hull[i - 1][1]);
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  if (lenPch < 0.85 || lenPch > 1.25 || gap > hullPerimeter * 0.18) return null;

  const fill = areaPolygon(hull) / (w * h); // Ach / Aer
  if (alt < 0.47 && fill > 0.68 && fill < 0.87) return ellipseShape(x0, y0, x1, y1);
  if (alt >= 0.44 && alt < 0.62 && fill >= 0.87) return rectShape(x0, y0, x1, y1);
  return null;
}
