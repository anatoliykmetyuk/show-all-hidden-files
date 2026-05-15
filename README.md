# Show All Hidden Files

An Obsidian desktop plugin that reveals every dot-prefixed hidden file and
folder in the current vault, at any depth.

This plugin intentionally has no default exclusions. It can reveal sensitive or
high-volume paths such as `.obsidian`, `.git`, `.venv`, `.env`, `.trash`, and
`.DS_Store`.

## Usage

1. Place this folder at `<vault>/.obsidian/plugins/show-all-hidden-files`.
2. In Obsidian, open Settings -> Community plugins.
3. Enable **Show All Hidden Files**.
4. Run **Show All Hidden Files: Rescan hidden files** from the command palette
   if hidden files were created after startup.

The plugin also enables Obsidian's unsupported-file visibility setting while it
is active, so non-Markdown hidden files can appear in the file explorer.

## Behavior

- Reveals any vault-relative path with a segment beginning with `.`.
- Works for root-level and nested hidden paths.
- Does not rename, delete, or modify vault files.
- Does not follow symlinked directories during scans, to avoid recursive loops.
- Restores patched Obsidian internals and the previous unsupported-file setting
  when disabled.

## Compatibility

This is desktop-only. It depends on Obsidian's local filesystem adapter and
undocumented internals, so it may need updates if Obsidian changes those
internals.
