# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com),
and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Linux (Ubuntu) support.** OS-specific code moved into `src-tauri/src/platform/`. On Linux, scanning `/` covers local disk partitions, the freedesktop Trash is used, Low CPU mode uses `nice` and idle I/O priority, and the Linux paths of common caches, editors and SDKs are recognised. macOS-only features (Applications, Quick Look, hidden space, Full Disk Access) are hidden there. CI runs on Ubuntu too, and releases include a `.deb` and an `.AppImage`. See the feature table in the README.
- **Photos** screen: finds blurry photos, screenshots and groups of near-identical shots, and suggests which to keep.
- **Changes since the previous scan.** Folders show how much they grew or shrank, the status bar shows the change for the current folder, and a **Changes** tab lists the biggest changes.
- **Untouched for 1 year+** filter in the Largest Files tab, with each file's age.
- **Hidden space** (macOS) on the home screen: purgeable space and Time Machine local snapshots, with a confirmed button to delete the snapshots.
- **Drag & drop** a folder onto the window to scan it.
- **Quick Look** (macOS): press Space on a row or photo, or use the right-click menu.
- **Menu bar / tray icon** with free space and shortcuts to scan the home folder or the whole disk.
- **Languages.** Korean, Spanish, French, German, Italian, Brazilian Portuguese, Russian, Indonesian.
- **PayPal** option on the Support screen.
- Previous scans show how much disk space each cached result uses, with a **Clear cache** button to delete them all.
- **Empty Trash** button on the home screen when the Trash isn't empty, showing its size. It uses the same two-step permanent-delete confirmation.
- The treemap's grouped "N items" tile can be clicked to show the next 40 smaller items. A breadcrumb entry and ⌫ take you back.
- The sidebar has a name filter.
- **Developer** screen: finds rebuildable project folders (node_modules, target, .venv, build outputs…), package caches, SDKs and toolchains, editor and AI tool data, old versions, and git/Claude/Codex worktrees. Items are grouped by project with their last activity, marked safe / rebuild / caution with the command that brings them back, and can be quick-selected (stale projects, old versions).
- **Safety colours.** Every item is marked safe, review, risky or unknown based on where it is (for example `~/Library/Caches` is safe, `/System`, app data, Mail and `.git` are risky). The treemap can be coloured by safety, with a legend.
- **Bubbles view** (circle packing), as an alternative to the treemap.
- **Cleanup** sidebar tab, listing the safe-to-clean items under the current folder, and a **Summary** tab with sizes by safety and by category.
- Deleting items marked risky shows an extra warning.
- Developer cleanup rules can be extended or overridden in `~/.config/disklens/rules.json`, edited in the app with live validation. Changes made in another editor are picked up.

### Changed

- The cache format changed (it now stores file dates and the previous scan). Results cached by older versions are rescanned when opened, and the old result becomes the baseline that changes are compared with.
- "Safe to clean" now depends on the full path instead of the folder name alone. Before, `/System/Library/Caches`, any `Logs` folder, and `build`/`out`/`target` folders were all marked safe.
- App and other code bundles are no longer walked file by file during a scan; opening one reads its contents. This makes scans of `/` smaller and faster.
- Scanning `/` skips the APFS `/.vol`, `/.nofollow` and `/.resolve` folders.
- Only the 10 most recent scans are kept; older cached results are deleted automatically.
- Cached results older than a day show a banner offering a rescan.
- The sidebar lists every item in a folder (previously capped at 300) and renders only the visible rows, so large folders stay smooth.
- Folders can be opened while a scan is still running, once their size is final. Deleting and rescanning still wait for the scan to finish.

## [0.1.0]

First public version.

### Added

- **Treemap and sidebar.**
  - Each tile shows a kind colour and icon, and every entry gets a minimum tile area.
  - The sidebar has a donut chart, Current Folder and Largest Files tabs, and multi-select with shift-click ranges.
- **Right-click menu.** Open, Copy Path, Open in Finder, Rescan Folder, Move to Trash, Delete Permanently. These also work on a multi-selection.
- **Delete confirmations.** Move to Trash asks once; permanent delete asks twice. System paths are protected.
- **Scanning.**
  - Low CPU, Balanced and Fast modes.
  - Live results while scanning; stop and fall back to the previous result.
  - Cached results.
- **Applications screen.**
  - Icons, versions, last used date, size including `~/Library` data.
  - App Store and Sparkle update checks.
  - Uninstall and reset app data.
- **Full Disk Access.** Detects when it's missing and links to the settings screen.
- **Languages.** English, Vietnamese, Simplified Chinese, Japanese.
