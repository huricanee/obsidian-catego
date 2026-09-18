import { Plugin, TFile, TFolder, Notice } from 'obsidian';
import { CategoView, VIEW_TYPE_CATEGO } from './view';

/**
 * One `.catego` file = one board. No accounts, no registration, no board list —
 * boards are just files in your vault (like Excalidraw drawings).
 */
export default class CategoPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_CATEGO, (leaf) => new CategoView(leaf));
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

    // Add the active file (note, PDF, image, …) as a node in the open board.
    this.addCommand({
      id: 'note-to-node',
      name: 'Add this file as a node in the open Catego board',
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

  private async newBoard(folder: string) {
    const dir = folder ? `${folder}/` : '';
    let path = `${dir}Untitled.catego`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${dir}Untitled ${i++}.catego`;
    try {
      const file = await this.app.vault.create(path, '');
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (e: any) {
      new Notice(`Could not create board: ${e?.message ?? e}`);
    }
  }
}
