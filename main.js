const { FileSystemAdapter, Notice, Plugin, TFile, TFolder, normalizePath } = require("obsidian");
const fs = require("fs");
const path = require("path");

const NOTICE_MS = 6000;

module.exports = class ShowAllHiddenFilesPlugin extends Plugin {
  async onload() {
    this.adapter = this.app.vault.adapter;
    this.basePath = this.getBasePath();
    this.patchRestorers = [];
    this.indexedPaths = new Set();
    this.originalShowUnsupportedFiles = undefined;
    this.isScanning = false;

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
        new Notice(`Show All Hidden Files has indexed ${this.indexedPaths.size} hidden paths.`, NOTICE_MS);
        console.log("[show-all-hidden-files] indexed hidden paths", Array.from(this.indexedPaths).sort());
      },
    });

    this.app.workspace.onLayoutReady(() => {
      void this.rescanHiddenFiles(false);
    });
  }

  onunload() {
    for (const restore of this.patchRestorers.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        console.error("[show-all-hidden-files] failed to restore adapter patch", error);
      }
    }

    this.restoreUnsupportedFiles();
  }

  isSupportedDesktopAdapter() {
    return (
      this.adapter instanceof FileSystemAdapter &&
      typeof this.basePath === "string" &&
      this.basePath.length > 0
    );
  }

  getBasePath() {
    if (this.adapter && typeof this.adapter.getBasePath === "function") {
      return this.adapter.getBasePath();
    }

    return "";
  }

  rememberAndEnableUnsupportedFiles() {
    const vault = this.app.vault;
    const getConfig = vault && vault.getConfig;
    const setConfig = vault && vault.setConfig;

    if (typeof setConfig !== "function") {
      return;
    }

    try {
      this.originalShowUnsupportedFiles =
        typeof getConfig === "function" ? getConfig.call(vault, "showUnsupportedFiles") : undefined;
      setConfig.call(vault, "showUnsupportedFiles", true);
    } catch (error) {
      console.warn("[show-all-hidden-files] unable to enable unsupported file visibility", error);
    }
  }

  restoreUnsupportedFiles() {
    if (this.originalShowUnsupportedFiles === undefined) {
      return;
    }

    const vault = this.app.vault;
    const setConfig = vault && vault.setConfig;

    if (typeof setConfig !== "function") {
      return;
    }

    try {
      setConfig.call(vault, "showUnsupportedFiles", this.originalShowUnsupportedFiles);
    } catch (error) {
      console.warn("[show-all-hidden-files] unable to restore unsupported file visibility", error);
    }
  }

  patchAdapter() {
    this.patchReconcileDeletion();
    this.patchReconcileFile();
    this.patchListRecursiveChild();
  }

  patchReconcileDeletion() {
    if (typeof this.adapter.reconcileDeletion !== "function") {
      return;
    }

    const original = this.adapter.reconcileDeletion;
    const plugin = this;

    this.adapter.reconcileDeletion = function patchedReconcileDeletion(normalizedPath, ...rest) {
      if (plugin.isHiddenVaultPath(normalizedPath)) {
        plugin.revealPath(normalizedPath);
        return;
      }

      return original.call(this, normalizedPath, ...rest);
    };

    this.patchRestorers.push(() => {
      this.adapter.reconcileDeletion = original;
    });
  }

  patchReconcileFile() {
    if (typeof this.adapter.reconcileFile !== "function") {
      return;
    }

    const original = this.adapter.reconcileFile;
    const plugin = this;

    this.adapter.reconcileFile = function patchedReconcileFile(normalizedPath, ...rest) {
      if (plugin.isHiddenVaultPath(normalizedPath)) {
        void plugin.revealPath(normalizedPath);
        return;
      }

      return original.call(this, normalizedPath, ...rest);
    };

    this.patchRestorers.push(() => {
      this.adapter.reconcileFile = original;
    });
  }

  patchListRecursiveChild() {
    if (typeof this.adapter.listRecursiveChild !== "function") {
      return;
    }

    const original = this.adapter.listRecursiveChild;
    const plugin = this;

    this.adapter.listRecursiveChild = function patchedListRecursiveChild(normalizedPath, child, ...rest) {
      const childName = typeof child === "string" ? child : child && child.name;
      const childPath = normalizePath(normalizedPath ? `${normalizedPath}/${childName}` : childName || "");

      if (plugin.isHiddenVaultPath(childPath)) {
        void plugin.revealPath(childPath);
      }

      return original.call(this, normalizedPath, child, ...rest);
    };

    this.patchRestorers.push(() => {
      this.adapter.listRecursiveChild = original;
    });
  }

  async rescanHiddenFiles(showNotice) {
    if (this.isScanning) {
      if (showNotice) {
        new Notice("Show All Hidden Files is already scanning.", NOTICE_MS);
      }
      return;
    }

    this.isScanning = true;
    const startedWith = this.indexedPaths.size;

    try {
      const hiddenPaths = [];
      await this.walkVault("", hiddenPaths);

      hiddenPaths.sort((a, b) => {
        const depth = a.split("/").length - b.split("/").length;
        return depth || a.localeCompare(b);
      });

      for (const hiddenPath of hiddenPaths) {
        await this.revealPath(hiddenPath);
      }

      if (showNotice) {
        const added = this.indexedPaths.size - startedWith;
        new Notice(`Show All Hidden Files indexed ${this.indexedPaths.size} hidden paths (${added} new).`, NOTICE_MS);
      }
    } catch (error) {
      console.error("[show-all-hidden-files] scan failed", error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Show All Hidden Files scan failed: ${message}`, NOTICE_MS);
    } finally {
      this.isScanning = false;
    }
  }

  async walkVault(relativePath, hiddenPaths) {
    const absolutePath = relativePath ? path.join(this.basePath, relativePath) : this.basePath;
    let entries;

    try {
      entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      console.warn(`[show-all-hidden-files] unable to read ${relativePath || "/"}`, error);
      return;
    }

    for (const entry of entries) {
      const childPath = normalizePath(relativePath ? `${relativePath}/${entry.name}` : entry.name);
      const isHidden = this.isHiddenVaultPath(childPath);

      if (isHidden) {
        hiddenPaths.push(childPath);
      }

      if (entry.isDirectory()) {
        await this.walkVault(childPath, hiddenPaths);
      }
    }
  }

  async revealPath(normalizedPath) {
    const cleanPath = normalizePath(normalizedPath || "");

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
    const item = stat.isDirectory()
      ? new TFolder(this.app.vault, cleanPath)
      : new TFile(this.app.vault, cleanPath);

    item.name = name;
    item.parent = parent;
    item.vault = this.app.vault;
    item.path = cleanPath;
    item.stat = {
      ctime: stat.birthtimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    };

    this.registerVaultItem(parent, item);
    this.indexedPaths.add(cleanPath);

    return item;
  }

  async revealParentPath(childPath) {
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

  async ensureParentFolder(childPath) {
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

    return this.revealPath(parentPath);
  }

  registerVaultItem(parent, item) {
    const files = this.adapter.files;
    if (files && typeof files === "object") {
      files[item.path] = item;
    }

    const children = parent.children;
    if (Array.isArray(children) && !children.some((child) => child.path === item.path)) {
      children.push(item);
      children.sort((a, b) => a.name.localeCompare(b.name));
    }

    const cache = this.app.metadataCache;
    if (cache && typeof cache.trigger === "function") {
      cache.trigger("changed", item, "", undefined);
    }
  }

  statVaultPath(normalizedPath) {
    try {
      const absolutePath = path.join(this.basePath, normalizedPath);
      return fs.statSync(absolutePath);
    } catch (error) {
      console.warn(`[show-all-hidden-files] unable to stat ${normalizedPath}`, error);
      return null;
    }
  }

  isHiddenVaultPath(normalizedPath) {
    return normalizePath(normalizedPath || "")
      .split("/")
      .filter(Boolean)
      .some((segment) => segment.startsWith("."));
  }
};
