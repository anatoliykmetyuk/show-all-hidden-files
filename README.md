# Show All Hidden Files

An Obsidian desktop plugin that reveals every dot-prefixed hidden file and
folder in the current vault, at any depth.

This plugin intentionally has no default exclusions. It can reveal sensitive or
high-volume paths such as `.obsidian`, `.git`, `.venv`, `.env`, `.trash`, and
`.DS_Store`.

## Usage

1. Install and enable **Show All Hidden Files**.
2. Run **Show All Hidden Files: Rescan hidden files** from the command palette
   if hidden files were created after startup.
3. Optional: add exact file or folder names in **Settings > Community plugins >
   Show All Hidden Files > Ignored names** to keep those names hidden anywhere
   in the vault.

The plugin also enables Obsidian's unsupported-file visibility setting while it
is active, so non-Markdown hidden files can appear in the file explorer.

## Behavior

- Reveals any vault-relative path with a segment beginning with `.`.
- Keeps ignored names hidden by exact file or folder name, independent of path.
- Skips ignored folders and any hidden files or folders inside them.
- Works for root-level and nested hidden paths.
- Does not rename, delete, or modify vault files.
- Does not follow symlinked directories during scans, to avoid recursive loops.
- Restores patched Obsidian internals and the previous unsupported-file setting
  when disabled.

## Compatibility

This is desktop-only. It depends on Obsidian's local filesystem adapter and
undocumented internals, so it may need updates if Obsidian changes those
internals.

## Security and privacy

- Uses Node.js filesystem APIs to scan the current vault.
- Uses undocumented Obsidian internals to register hidden paths in the file
  explorer.
- Reveals hidden files that may contain secrets or configuration.
- Does not use telemetry.
- Does not make network requests.
- Does not require an account or external service.
- Does not include ads or paid features.

## Development

Install dependencies:

```sh
npm ci
```

Build the plugin:

```sh
npm run build
```

The build writes `main.js`, which Obsidian loads locally. `main.js` is generated
and is not committed to the repository.

## Release

Releases are created by GitHub Actions when a semantic version tag is pushed.
The tag must exactly match `manifest.json`'s `version`, for example `0.1.0`.

The release workflow builds the plugin and attaches:

- `main.js`
- `manifest.json`
