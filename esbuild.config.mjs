import esbuild from 'esbuild';
import process from 'process';
import fs from 'fs';
import path from 'path';

const prod = process.argv.includes('production');

// Resolve every runtime dependency from this package's own node_modules, so the
// bundle is exactly what package-lock.json describes (and a single React copy).
//
// This re-resolves the import AS A PACKAGE from here (honouring its `exports` /
// `browser` fields). A plain path alias would not: it resolves a directory via
// `main`, which e.g. hands `marked` its UMD build and leaves the named import
// undefined.
const pkgDeps = Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies || {});
const pinDeps = {
  name: 'pin-deps',
  setup(build) {
    const esc = (d) => d.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const filter = new RegExp(`^(?:${pkgDeps.map(esc).join('|')})(?:/.*)?$`);
    build.onResolve({ filter }, (args) => {
      if (args.pluginData?.pinned) return undefined;   // our own re-entry → default resolution
      return build.resolve(args.path, { resolveDir: process.cwd(), kind: args.kind, pluginData: { pinned: true } });
    });
  },
};

// canvas.css ships as the plugin's styles.css.
function generateStyles() {
  const canvasCss = fs.readFileSync('src/shared/canvas.css', 'utf8');
  // The web toolbars/panel use position:fixed (relative to the whole window).
  // Inside an Obsidian pane we re-anchor them to the board with position:absolute,
  // tools on the right, properties on the left.
  // The web toolbars/panel use position:fixed (window) and the theme vars live in
  // src/index.css (not canvas.css). Inside a pane we scope the vars to the board
  // and re-anchor with position:absolute: tools on top, properties on the left.
  const wrapper = `
.workspace-leaf-content[data-type="catego-view"] > .view-content { padding: 0 !important; }
.view-content.catego-view { padding: 0 !important; overflow: hidden; }
.catego-root {
  position: absolute; inset: 0; overflow: hidden;
  --bg: #000000; --surface: #111118; --toolbar-bg: rgba(17,17,24,0.95);
  --text: #e0e0e8; --text-muted: #6a6a80; --accent: #cf7bf0; --border: #1e1e2e;
  --grid-dot: rgba(207,123,240,0.18); --danger: #ff4d4d;
  background: var(--bg);
}
.catego-root .canvas-root { position: absolute; inset: 0; }
.catego-root .toolbar { position: absolute; }
.catego-root .toolbar.toolbar-tools {
  top: 44px; left: 50%; right: auto; bottom: auto; transform: translateX(-50%); flex-direction: row;
}
.catego-root .props-panel {
  position: absolute; left: 12px; right: auto; top: 50%; transform: translateY(-50%);
  max-height: 88%; z-index: 110;
}
.catego-root .color-swatch { width: 18px; height: 18px; min-width: 0; padding: 0; flex: 0 0 auto; box-shadow: none; }
.catego-root .toolbar-btn.props-toggle { position: absolute; top: 44px; left: 12px; }
.catego-root .mode-badge { position: absolute; top: 44px; right: 14px; bottom: auto; }
`;
  // KaTeX stylesheet with its woff2 fonts inlined as data URIs, so LaTeX renders
  // self-contained inside the pane (relative font url()s can't resolve there).
  let katexCss = '';
  try {
    const dir = path.resolve('node_modules/katex/dist');
    katexCss = fs.readFileSync(path.join(dir, 'katex.min.css'), 'utf8')
      .replace(/url\(fonts\/(KaTeX_[A-Za-z0-9_-]+)\.woff2\)/g, (m, name) => {
        try {
          const b = fs.readFileSync(path.join(dir, 'fonts', `${name}.woff2`));
          return `url(data:font/woff2;base64,${b.toString('base64')})`;
        } catch { return m; }
      })
      // drop the woff/ttf fallbacks (their relative urls would 404; woff2 is inlined)
      .replace(/,\s*url\(fonts\/KaTeX_[A-Za-z0-9_-]+\.woff\)\s*format\("woff"\)/g, '')
      .replace(/,\s*url\(fonts\/KaTeX_[A-Za-z0-9_-]+\.ttf\)\s*format\("truetype"\)/g, '');
  } catch { /* katex not installed — skip */ }

  fs.writeFileSync('styles.css', `${wrapper}\n${canvasCss}\n${katexCss}`);
}

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@electron/remote', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  jsx: 'automatic',
  plugins: [pinDeps],
  loader: {
    '.css': 'empty',   // CSS imported from JS (canvas.css, katex.css) ships via styles.css instead
    '.png': 'dataurl',
    '.svg': 'dataurl',
  },
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

generateStyles();

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log('[catego] esbuild watching…');
}
