import { Plugin, TFile, TFolder, Notice } from 'obsidian';
import { CategoView, VIEW_TYPE_CATEGO } from './view';
import { emptyBoard, serializeBoard } from './format';
// @ts-ignore — pure ESM geometry, shared with the web app
import { makeDoc } from './shared/pages.js';

/**
 * One `.catego` file = one board. No accounts, no registration, no board list —
 * boards are just files in your vault (like Excalidraw drawings).
 */
export interface Prefs {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export default class CategoPlugin extends Plugin {
  /** Per-user board UI preferences (panel open, theme, …), kept in the plugin's data.json. */
  private prefValues: Record<string, string> = {};
  prefs: Prefs = {
    get: (k) => (k in this.prefValues ? this.prefValues[k] : null),
    set: (k, v) => {
      if (this.prefValues[k] === v) return;
      this.prefValues[k] = v;
      this.saveData({ prefs: this.prefValues });
    },
  };

  async onload() {
    const data = await this.loadData();
    if (data && data.prefs && typeof data.prefs === 'object') this.prefValues = { ...data.prefs };

    this.registerView(VIEW_TYPE_CATEGO, (leaf) => new CategoView(leaf, this.prefs));
    try {
      this.registerExtensions(['catego'], VIEW_TYPE_CATEGO);
    } catch (e) {
      // Another plugin already owns .catego — ignore.
    }

    // Create a board — command palette (creates next to the active file).
    this.addCommand({
      id: 'new-board',
      name: 'Create new board',
      callback: () => this.newBoard(this.activeFolder()),
    });

    // Create a notebook — a board made of ruled sheets instead of an infinite canvas.
    this.addCommand({
      id: 'new-notebook',
      name: 'Create new notebook (sheets)',
      callback: () => this.newBoard(this.activeFolder(), serializeBoard({ ...emptyBoard(), doc: makeDoc('a4', 'ruled') }), 'Notebook'),
    });

    // Add the active file (note, PDF, image, …) as a node in the open board.
    this.addCommand({
      id: 'note-to-node',
      name: 'Add this file as a node in the open board',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const view = this.activeCategoView();
        if (file && view && view.file?.path !== file.path) {
          if (!checking) view.addNoteFromMenu(file);
          return true;
        }
        return false;
      },
    });

    // File-explorer context menu.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item.setTitle('New Catego board').setIcon('git-fork').onClick(() => this.newBoard(file.path)),
          );
          menu.addItem((item) =>
            item.setTitle('New Catego notebook').setIcon('notebook').onClick(() =>
              this.newBoard(file.path, serializeBoard({ ...emptyBoard(), doc: makeDoc('a4', 'ruled') }), 'Notebook')),
          );
        } else if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') {
          // A PDF becomes a notebook whose sheets are its pages, to write over.
          menu.addItem((item) =>
            item.setTitle('Annotate in Catego (new notebook)').setIcon('notebook').onClick(() => this.annotatePdf(file)),
          );
          const view = this.activeCategoView();
          if (view) {
            menu.addItem((item) =>
              item.setTitle('Add PDF pages to the open Catego notebook').setIcon('file-plus').onClick(() => view.importPdf(file.path)),
            );
          }
        } else if (file instanceof TFile) {
          // Any file type can be added as a node (the node links to the file);
          // only adding a board to itself is excluded.
          const view = this.activeCategoView();
          if (view && view.file?.path !== file.path) {
            menu.addItem((item) =>
              item.setTitle('Add as Catego node').setIcon('git-fork').onClick(() => view.addNoteFromMenu(file)),
            );
          }
        }
      }),
    );
  }

  private activeCategoView(): CategoView | null {
    const active = this.app.workspace.getActiveViewOfType(CategoView);
    if (active) return active;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CATEGO);
    return leaves.length ? (leaves[0].view as CategoView) : null;
  }

  /** Folder of the active file, or vault root. */
  private activeFolder(): string {
    const f = this.app.workspace.getActiveFile();
    const parent = f?.parent?.path;
    return parent && parent !== '/' ? parent : '';
  }

  private async annotatePdf(pdf: TFile) {
    const folder = pdf.parent && pdf.parent.path !== '/' ? pdf.parent.path : '';
    const file = await this.newBoard(folder, serializeBoard({ ...emptyBoard(), doc: makeDoc('a4', 'blank') }), pdf.basename);
    if (!file) return;
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_CATEGO).map((l) => l.view as CategoView).find((v) => v.file?.path === file.path);
    if (view) view.importPdf(pdf.path);
  }

  private async newBoard(folder: string, content = '', base = 'Untitled'): Promise<TFile | null> {
    const dir = folder ? `${folder}/` : '';
    let path = `${dir}${base}.catego`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${dir}${base} ${i++}.catego`;
    try {
      const file = await this.app.vault.create(path, content);
      await this.app.workspace.getLeaf(true).openFile(file);
      return file;
    } catch (e: any) {
      new Notice(`Could not create board: ${e?.message ?? e}`);
      return null;
    }
  }
}
