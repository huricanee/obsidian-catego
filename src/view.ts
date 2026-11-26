import { TextFileView, WorkspaceLeaf, TFile, Notice, loadPdfJs, normalizePath } from 'obsidian';
import { createElement } from 'react';
import { createRoot, Root } from 'react-dom/client';
// @ts-ignore — the shared board editor (same component the web app renders)
import Board from './shared/Board.jsx';
import { CategoBoard, parseBoard, serializeBoard, emptyBoard } from './format';
// @ts-ignore — pure ESM logic shared with the web app and the CLI
import { parseAgentFile, parseAgentMarkdown, AGENT_FILE_SUFFIX, AGENT_MD_SUFFIX } from './shared/agentOps.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

export const VIEW_TYPE_CATEGO = 'catego-view';

interface Bridge {
  addNoteNodeAtScreen?: (path: string, title: string, clientX: number, clientY: number) => void;
  renameNote?: (oldPath: string, newPath: string, newTitle: string) => void;
  importPdfSrc?: (src: string) => Promise<void>;
  addImageSrc?: (src: string, clientX?: number, clientY?: number) => void;
  applyAgentOps?: (ops: any[], done: string[]) => string[];
}

/**
 * Bridges the vault file and the React editor. Note-node actions (drag&drop,
 * menu, rename) reach the live editor through `bridge`, so no remount/state loss.
 */
export class CategoView extends TextFileView {
  board: CategoBoard = emptyBoard();
  private root: Root | null = null;
  private reload = 0;
  private bridge: Bridge = {};
  private agentStamp = '';

  // Where the board's pictures and PDFs live: ordinary vault files, referenced
  // by vault path (so they sync, back up and open like any attachment).
  private assets = {
    save: async (blob: Blob, name: string): Promise<string> => {
      const safe = (name || 'file').replace(/[\\/:*?"<>|#^[\]]/g, '_');
      const path = await this.app.fileManager.getAvailablePathForAttachment(safe, this.file?.path);
      await this.app.vault.createBinary(path, await blob.arrayBuffer());
      return path;
    },
    url: async (src: string): Promise<string | null> => {
      const f = this.assetFile(src);
      return f ? this.app.vault.getResourcePath(f) : null;
    },
    data: async (src: string): Promise<ArrayBuffer | null> => {
      const f = this.assetFile(src);
      return f ? this.app.vault.readBinary(f) : null;
    },
  };
  private pdfJs = () => loadPdfJs();

  private assetFile(src: string): TFile | null {
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(src));
    if (direct instanceof TFile) return direct;
    const linked = this.app.metadataCache.getFirstLinkpathDest(src, this.file?.path ?? '');
    return linked instanceof TFile ? linked : null;
  }

  constructor(leaf: WorkspaceLeaf, private prefs: { get(k: string): string | null; set(k: string, v: string): void }) { super(leaf); }

  getViewType() { return VIEW_TYPE_CATEGO; }
  getDisplayText() { return this.file?.basename ?? 'Catego'; }
  getIcon() { return 'git-fork'; }

  getViewData(): string { return serializeBoard(this.board); }

  setViewData(data: string, _clear: boolean) {
    this.board = data.trim() ? parseBoard(data) : emptyBoard();
    this.reload += 1;
    this.renderBoard();
    this.agentStamp = '';
    window.setTimeout(() => this.syncAgent(), 400);
  }

  clear() { this.board = emptyBoard(); }

  async onOpen() {
    this.contentEl.addClass('catego-view');
    // Drag a note from the file explorer onto the board → node.
    this.registerDomEvent(this.contentEl, 'dragover', (e) => {
      if (this.draggedFile()) { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'copy'); }
    });
    this.registerDomEvent(this.contentEl, 'drop', (e) => this.onDrop(e));
    // Keep note-node titles/links in sync when a note is renamed/moved.
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.onVaultRename(f, oldPath)));
    // Agent inbox (see src/agentOps.js): apply what an AI wrote next to the board.
    const inboxChanged = (f: any) => { if (f && (f.path === this.agentPath() || f.path === this.agentPath(AGENT_MD_SUFFIX))) this.syncAgent(); };
    this.registerEvent(this.app.vault.on('modify', inboxChanged));
    this.registerEvent(this.app.vault.on('create', inboxChanged));
    this.registerInterval(window.setInterval(() => this.syncAgent(), 5000));
    this.renderBoard();
  }

  async onClose() {
    if (this.root) { this.root.unmount(); this.root = null; }
  }

  private renderBoard() {
    if (!this.root) this.root = createRoot(this.contentEl);
    this.root.render(
      createElement(Board, {
        key: this.reload,
        initial: { nodes: this.board.nodes, arrows: this.board.arrows, regions: this.board.regions, strokes: this.board.strokes, notes: this.board.notes, doc: this.board.doc || null },
        onPersist: (g: any) => this.persist(g),
        onOpenNote: (p: string) => this.openNote(p),
        onRenameNoteFile: (oldPath: string, newTitle: string) => this.renameNoteFile(oldPath, newTitle),
        onSaveNote: (kind: string, markdown: string) => this.saveNote(kind, markdown),
        bridge: this.bridge,
        isolateKeys: true,
        prefs: this.prefs,
        assets: this.assets,
        loadPdfJs: this.pdfJs,
      }),
    );
  }

  // node → note: rename the vault file to match the node's edited title.
  private renameNoteFile(oldPath: string, newTitle: string) {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(file instanceof TFile)) return;
    const safe = newTitle.replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
    if (!safe || safe === file.basename) return;
    const dir = file.parent && file.parent.path && file.parent.path !== '/' ? `${file.parent.path}/` : '';
    const newPath = `${dir}${safe}.${file.extension}`;
    if (this.app.vault.getAbstractFileByPath(newPath)) { new Notice(`"${safe}" already exists`); return; }
    this.app.fileManager.renameFile(file, newPath).catch((e: any) => new Notice(`Rename failed: ${e?.message ?? e}`));
  }

  private persist(graph: any) {
    this.board.nodes = graph.nodes;
    this.board.arrows = graph.arrows;
    this.board.regions = graph.regions;
    this.board.strokes = graph.strokes;
    this.board.doc = graph.doc || null;
    if (graph.notes) this.board.notes = graph.notes;
    this.requestSave();
  }

  /** A note generated from the board (its highlights): `Name — kind.md` next to it. */
  private async saveNote(kind: string, markdown: string): Promise<string> {
    if (!this.file) throw new Error('no file');
    const dir = this.file.parent && this.file.parent.path !== '/' ? `${this.file.parent.path}/` : '';
    const path = normalizePath(`${dir}${this.file.basename} — ${kind}.md`);
    const body = `# ${this.file.basename} — ${kind}\n\n${markdown}`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
    return path.split('/').pop() as string;
  }

  // --- agent inbox -----------------------------------------------------------
  // `Name.agent.json` next to `Name.catego`: the only file an AI writes. This
  // view is the only writer of the board file, so sync never sees two writers.
  // An agent that can only write notes uses `Name.agent.md` (same operations).
  private agentPath(suffix: string = AGENT_FILE_SUFFIX): string | null {
    return this.file ? this.file.path.replace(/\.catego$/i, '') + suffix : null;
  }

  private async syncAgent() {
    if (!this.file || !this.bridge.applyAgentOps) return;
    try {
      const adapter = this.app.vault.adapter;
      const files: [string, (t: string) => any[]][] = [
        [this.agentPath() as string, parseAgentFile],
        [this.agentPath(AGENT_MD_SUFFIX) as string, parseAgentMarkdown],
      ];
      const stats = await Promise.all(files.map(([p]) => adapter.stat(p).catch(() => null)));
      const stamp = stats.map((s) => (s ? s.mtime : 0)).join('/');
      if (stamp === this.agentStamp) return;
      let ops: any[] = [];
      for (let i = 0; i < files.length; i++) if (stats[i]) ops = ops.concat(files[i][1](await adapter.read(files[i][0])));
      const done = this.board.agentApplied || [];
      const seen = new Set(done);
      const pending = ops.filter((o: any) => !seen.has(o.id));
      if (pending.length) {
        const applied = this.bridge.applyAgentOps(pending, done);
        if (applied.length) {
          // Saved together with the objects by the board's next persist().
          this.board.agentApplied = [...done, ...applied];
          new Notice(`Catego: ${applied.length} change${applied.length === 1 ? '' : 's'} from the assistant`);
        }
      }
      this.agentStamp = stamp;
    } catch { /* no inbox, or unreadable — try again later */ }
  }

  /** Vault PDF → sheets of this board (retries while the editor mounts). */
  importPdf(path: string, tries = 20) {
    if (this.bridge.importPdfSrc) { this.bridge.importPdfSrc(path); return; }
    if (tries > 0) window.setTimeout(() => this.importPdf(path, tries - 1), 150);
  }

  // The file currently being dragged (Obsidian sets this on internal drags).
  // Any vault file can become a node — .md notes, PDFs, images, audio, other
  // boards — except this board itself.
  private draggedFile(): TFile | null {
    const dm = (this.app as any).dragManager;
    const f = dm?.draggable?.file;
    if (!(f instanceof TFile)) return null;
    if (this.file && f.path === this.file.path) return null;
    return f;
  }

  private onDrop(e: DragEvent) {
    const f = this.draggedFile();
    if (!f) return;
    e.preventDefault();
    // A picture is shown as a picture; anything else becomes a node linking to it.
    if (IMAGE_EXT.has(f.extension.toLowerCase()) && this.bridge.addImageSrc) { this.bridge.addImageSrc(f.path, e.clientX, e.clientY); return; }
    this.bridge.addNoteNodeAtScreen?.(f.path, f.basename, e.clientX, e.clientY);
  }

  // Called from the file-explorer "Add as Catego node" menu — drops at center.
  addNoteFromMenu(file: TFile) {
    const r = this.contentEl.getBoundingClientRect();
    if (this.bridge.addNoteNodeAtScreen) this.bridge.addNoteNodeAtScreen(file.path, file.basename, r.left + r.width / 2, r.top + r.height / 2);
    else new Notice('Open the Catego board first, then add the note.');
  }

  private onVaultRename(file: any, oldPath: string) {
    if (!(file instanceof TFile)) return;
    // The board itself moved: take its agent inbox along.
    if (this.file && file.path === this.file.path && /\.catego$/i.test(oldPath)) {
      for (const suffix of [AGENT_FILE_SUFFIX, AGENT_MD_SUFFIX]) {
        const from = oldPath.replace(/\.catego$/i, '') + suffix;
        const to = this.agentPath(suffix);
        if (to) this.app.vault.adapter.exists(from).then((yes) => (yes ? this.app.vault.adapter.rename(from, to) : undefined)).catch(() => {});
      }
    }
    if (this.bridge.renameNote) this.bridge.renameNote(oldPath, file.path, file.basename);
  }

  openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
    else new Notice(`Note not found: ${path}`);
  }
}
