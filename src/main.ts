import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  normalizePath,
} from "obsidian";
import * as fs from "node:fs";
import * as path from "node:path";

const NOTICE_MS = 6000;

type PatchRestorer = () => void;

type ReconcileMethod = (normalizedPath: string, ...rest: unknown[]) => unknown;
type ListRecursiveChildMethod = (normalizedPath: string, child: string | fs.Dirent, ...rest: unknown[]) => unknown;

interface FileSystemAdapterInternals extends FileSystemAdapter {
  files?: Record<string, TAbstractFile>;
  listRecursiveChild?: ListRecursiveChildMethod;
  reconcileDeletion?: ReconcileMethod;
  reconcileFile?: ReconcileMethod;
  reconcileFileInternal?: (normalizedPath: string, realPath: string) => Promise<unknown> | unknown;
}

interface VaultWithConfig extends Vault {
  getConfig?: (key: string) => unknown;
  setConfig?: (key: string, value: unknown) => void;
}

interface MutableAbstractFile extends TAbstractFile {
  name: string;
  parent: TFolder | null;
  path: string;
  stat: {
    ctime: number;
    mtime: number;
    size: number;
  };
  vault: Vault;
}

interface MetadataCacheWithTrigger {
  trigger?: (name: string, ...args: unknown[]) => void;
}

export default class ShowAllHiddenFilesPlugin extends Plugin {
  private adapter!: FileSystemAdapterInternals;
  private basePath = "";
  private readonly indexedPaths = new Set<string>();
  private isScanning = false;
  private originalShowUnsupportedFiles: unknown;
  private readonly patchRestorers: PatchRestorer[] = [];

  override async onload(): Promise<void> {
    this.adapter = this.app.vault.adapter as FileSystemAdapterInternals;
    this.basePath = this.getBasePath();

    if (!this.isSupportedDesktopAdapter()) {
      new Notice("Show All Hidden Files requires Obsidian desktop with FileSystemAdapter.", NOTICE_MS);
      return;
    }

    this.rememberAndEnableUnsupportedFiles();
    this.patchAdapter();

    this.addCommand({
      id: "rescan-hidden-files",
      name: "Rescan hidden files",
      callback: () => {
        void this.rescanHiddenFiles(true);
      },
    });

    this.addCommand({
      id: "report-indexed-hidden-files",
      name: "Report indexed hidden files",
      callback: () => {
        new Notice(`Indexed ${this.indexedPaths.size} hidden paths.`, NOTICE_MS);
      },
    });

    this.app.workspace.onLayoutReady(() => {
      void this.rescanHiddenFiles(false);
    });
  }

  override onunload(): void {
    for (const restore of this.patchRestorers.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        console.error("[show-all-hidden-files] failed to restore adapter patch", error);
      }
    }

    this.restoreUnsupportedFiles();
  }

  private isSupportedDesktopAdapter(): boolean {
    return this.adapter instanceof FileSystemAdapter && this.basePath.length > 0;
  }

  private getBasePath(): string {
    if (this.adapter && typeof this.adapter.getBasePath === "function") {
      return this.adapter.getBasePath();
    }

    return "";
  }

  private rememberAndEnableUnsupportedFiles(): void {
    const vault = this.app.vault as VaultWithConfig;

    if (typeof vault.setConfig !== "function") {
      return;
    }

    try {
      this.originalShowUnsupportedFiles =
        typeof vault.getConfig === "function" ? vault.getConfig("showUnsupportedFiles") : undefined;
      vault.setConfig("showUnsupportedFiles", true);
    } catch (error) {
      console.warn("[show-all-hidden-files] unable to enable unsupported file visibility", error);
    }
  }

  private restoreUnsupportedFiles(): void {
    if (this.originalShowUnsupportedFiles === undefined) {
      return;
    }

    const vault = this.app.vault as VaultWithConfig;

    if (typeof vault.setConfig !== "function") {
      return;
    }

    try {
      vault.setConfig("showUnsupportedFiles", this.originalShowUnsupportedFiles);
    } catch (error) {
      console.warn("[show-all-hidden-files] unable to restore unsupported file visibility", error);
    }
  }

  private patchAdapter(): void {
    this.patchReconcileDeletion();
    this.patchReconcileFile();
    this.patchListRecursiveChild();
  }

  private patchReconcileDeletion(): void {
    if (typeof this.adapter.reconcileDeletion !== "function") {
      return;
    }

    const original = this.adapter.reconcileDeletion;
    const plugin = this;

    this.adapter.reconcileDeletion = function patchedReconcileDeletion(normalizedPath, ...rest) {
      if (plugin.isHiddenVaultPath(normalizedPath)) {
        void plugin.revealPath(normalizedPath);
        return undefined;
      }

      return original.call(this, normalizedPath, ...rest);
    };

    this.patchRestorers.push(() => {
      this.adapter.reconcileDeletion = original;
    });
  }

  private patchReconcileFile(): void {
    if (typeof this.adapter.reconcileFile !== "function") {
      return;
    }

    const original = this.adapter.reconcileFile;
    const plugin = this;

    this.adapter.reconcileFile = function patchedReconcileFile(normalizedPath, ...rest) {
      if (plugin.isHiddenVaultPath(normalizedPath)) {
        void plugin.revealPath(normalizedPath);
        return undefined;
      }

      return original.call(this, normalizedPath, ...rest);
    };

    this.patchRestorers.push(() => {
      this.adapter.reconcileFile = original;
    });
  }

  private patchListRecursiveChild(): void {
    if (typeof this.adapter.listRecursiveChild !== "function") {
      return;
    }

    const original = this.adapter.listRecursiveChild;
    const plugin = this;

    this.adapter.listRecursiveChild = function patchedListRecursiveChild(normalizedPath, child, ...rest) {
      const childName = typeof child === "string" ? child : child.name;
      const childPath = normalizePath(normalizedPath ? `${normalizedPath}/${childName}` : childName);

      if (plugin.isHiddenVaultPath(childPath)) {
        void plugin.revealPath(childPath);
      }

      return original.call(this, normalizedPath, child, ...rest);
    };

    this.patchRestorers.push(() => {
      this.adapter.listRecursiveChild = original;
    });
  }

  private async rescanHiddenFiles(showNotice: boolean): Promise<void> {
    if (this.isScanning) {
      if (showNotice) {
        new Notice("Show All Hidden Files is already scanning.", NOTICE_MS);
      }
      return;
    }

    this.isScanning = true;
    const startedWith = this.indexedPaths.size;

    try {
      const hiddenPaths: string[] = [];
      await this.walkVault("", hiddenPaths);

      hiddenPaths.sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth || left.localeCompare(right);
      });

      for (const hiddenPath of hiddenPaths) {
        await this.revealPath(hiddenPath);
      }

      if (showNotice) {
        const added = this.indexedPaths.size - startedWith;
        new Notice(`Indexed ${this.indexedPaths.size} hidden paths (${added} new).`, NOTICE_MS);
      }
    } catch (error) {
      console.error("[show-all-hidden-files] scan failed", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Show All Hidden Files scan failed: ${message}`, NOTICE_MS);
    } finally {
      this.isScanning = false;
    }
  }

  private async walkVault(relativePath: string, hiddenPaths: string[]): Promise<void> {
    const absolutePath = relativePath ? path.join(this.basePath, relativePath) : this.basePath;
    let entries: fs.Dirent[];

    try {
      entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      console.warn(`[show-all-hidden-files] unable to read ${relativePath || "/"}`, error);
      return;
    }

    for (const entry of entries) {
      const childPath = normalizePath(relativePath ? `${relativePath}/${entry.name}` : entry.name);

      if (this.isHiddenVaultPath(childPath)) {
        hiddenPaths.push(childPath);
      }

      if (entry.isDirectory()) {
        await this.walkVault(childPath, hiddenPaths);
      }
    }
  }

  private async revealPath(normalizedPath: string): Promise<TAbstractFile | null> {
    const cleanPath = normalizePath(normalizedPath);

    if (!cleanPath || !this.isHiddenVaultPath(cleanPath)) {
      return null;
    }

    const existing = this.app.vault.getAbstractFileByPath(cleanPath);
    if (existing) {
      this.indexedPaths.add(cleanPath);
      return existing;
    }

    if (typeof this.adapter.reconcileFileInternal === "function") {
      try {
        await this.revealParentPath(cleanPath);
        await this.adapter.reconcileFileInternal(cleanPath, cleanPath);
        const reconciled = this.app.vault.getAbstractFileByPath(cleanPath);
        if (reconciled) {
          this.indexedPaths.add(cleanPath);
          return reconciled;
        }
      } catch (error) {
        console.warn(`[show-all-hidden-files] reconcileFileInternal failed for ${cleanPath}`, error);
      }
    }

    const stat = this.statVaultPath(cleanPath);
    if (!stat) {
      return null;
    }

    const parent = await this.ensureParentFolder(cleanPath);
    if (!parent) {
      return null;
    }

    const name = path.posix.basename(cleanPath);
    const item = Object.create(stat.isDirectory() ? TFolder.prototype : TFile.prototype) as MutableAbstractFile;

    item.name = name;
    item.parent = parent;
    item.path = cleanPath;
    item.stat = {
      ctime: stat.birthtimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
    item.vault = this.app.vault;

    this.registerVaultItem(parent, item);
    this.indexedPaths.add(cleanPath);

    return item;
  }

  private async revealParentPath(childPath: string): Promise<TAbstractFile | null> {
    const parentPath = path.posix.dirname(childPath);

    if (!parentPath || parentPath === ".") {
      return this.app.vault.getRoot();
    }

    const existing = this.app.vault.getAbstractFileByPath(parentPath);
    if (existing) {
      return existing;
    }

    if (!this.isHiddenVaultPath(parentPath)) {
      return null;
    }

    return this.revealPath(parentPath);
  }

  private async ensureParentFolder(childPath: string): Promise<TFolder | null> {
    const parentPath = path.posix.dirname(childPath);

    if (!parentPath || parentPath === ".") {
      return this.app.vault.getRoot();
    }

    const existing = this.app.vault.getAbstractFileByPath(parentPath);
    if (existing instanceof TFolder) {
      return existing;
    }

    const stat = this.statVaultPath(parentPath);
    if (!stat || !stat.isDirectory()) {
      return null;
    }

    const revealed = await this.revealPath(parentPath);
    return revealed instanceof TFolder ? revealed : null;
  }

  private registerVaultItem(parent: TFolder, item: MutableAbstractFile): void {
    if (this.adapter.files) {
      this.adapter.files[item.path] = item;
    }

    if (!parent.children.some((child) => child.path === item.path)) {
      parent.children.push(item);
      parent.children.sort((left, right) => left.name.localeCompare(right.name));
    }

    const cache = this.app.metadataCache as MetadataCacheWithTrigger;
    if (typeof cache.trigger === "function") {
      cache.trigger("changed", item, "", undefined);
    }
  }

  private statVaultPath(normalizedPath: string): fs.Stats | null {
    try {
      return fs.lstatSync(path.join(this.basePath, normalizedPath));
    } catch (error) {
      console.warn(`[show-all-hidden-files] unable to stat ${normalizedPath}`, error);
      return null;
    }
  }

  private isHiddenVaultPath(normalizedPath: string): boolean {
    return normalizePath(normalizedPath)
      .split("/")
      .filter(Boolean)
      .some((segment) => segment.startsWith("."));
  }
}
