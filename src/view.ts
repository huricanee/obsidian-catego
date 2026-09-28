import { TextFileView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { createElement } from 'react';
import { createRoot, Root } from 'react-dom/client';
// @ts-ignore — the shared board editor (same component the web app renders)
import Board from './shared/Board.jsx';
import { CategoBoard, parseBoard, serializeBoard, emptyBoard } from './format';

export const VIEW_TYPE_CATEGO = 'catego-view';

interface Bridge {
  addNoteNodeAtScreen?: (path: string, title: string, clientX: number, clientY: number) => void;
  renameNote?: (oldPath: string, newPath: string, newTitle: string) => void;
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

  constructor(leaf: WorkspaceLeaf) { super(leaf); }

  getViewType() { return VIEW_TYPE_CATEGO; }
  getDisplayText() { return this.file?.basename ?? 'Catego'; }
  getIcon() { return 'git-fork'; }

  getViewData(): string { return serializeBoard(this.board); }

  setViewData(data: string, _clear: boolean) {
    this.board = data.trim() ? parseBoard(data) : emptyBoard();
    this.reload += 1;
    this.renderBoard();
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
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.onRename(f, oldPath)));
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
        initial: { nodes: this.board.nodes, arrows: this.board.arrows, regions: this.board.regions, strokes: this.board.strokes, notes: this.board.notes },
        onPersist: (g: any) => this.persist(g),
        onOpenNote: (p: string) => this.openNote(p),
        onRenameNoteFile: (oldPath: string, newTitle: string) => this.renameNoteFile(oldPath, newTitle),
        bridge: this.bridge,
        isolateKeys: true,
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
    if (graph.notes) this.board.notes = graph.notes;
    this.requestSave();
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
    this.bridge.addNoteNodeAtScreen?.(f.path, f.basename, e.clientX, e.clientY);
  }

  // Called from the file-explorer "Add as Catego node" menu — drops at center.
  addNoteFromMenu(file: TFile) {
    const r = this.contentEl.getBoundingClientRect();
    if (this.bridge.addNoteNodeAtScreen) this.bridge.addNoteNodeAtScreen(file.path, file.basename, r.left + r.width / 2, r.top + r.height / 2);
    else new Notice('Open the Catego board first, then add the note.');
  }

  private onRename(file: any, oldPath: string) {
    if (!(file instanceof TFile)) return;
    if (this.bridge.renameNote) this.bridge.renameNote(oldPath, file.path, file.basename);
  }

  openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
    else new Notice(`Note not found: ${path}`);
  }
}
