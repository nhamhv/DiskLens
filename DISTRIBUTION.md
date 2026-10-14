# Distribution plan

How DiskLens gets from a git tag to people's machines: which channels, in which order, and what each one needs.
This is a plan, not a record of what exists. Section 1 says what is already in place.

## 1. Where we are

- `.github/workflows/release.yml` runs on a `v*` tag. It builds macOS (`.dmg`) and Ubuntu 22.04 (`.deb`, `.AppImage`) with `tauri-action` and attaches them to a **draft** GitHub release.
- Apple signing and notarization secrets are read by the workflow but **not set**, so the macOS build is unsigned (the README explains the right-click workaround).
- Only x86_64 Linux is built. There is no checksum file, no auto-update and no package repository.
- The version lives in three places: `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.

## 2. Principles

- **GitHub Releases is the single source.** Every other channel downloads or rebuilds from a tagged release. Nothing is published by hand.
- **Build once, sign once.** A channel never gets a different binary from the one on the release page, except where its store rebuilds from source (Flathub, Snap).
- **Add a channel only if it can be automated.** A channel that needs a manual step per release goes last.
- **Respect what the app does.** DiskLens reads the whole disk and deletes files. Sandboxed stores (Mac App Store, strict Snap, Flatpak) limit that, so each one has a stated trade-off below.

## 3. Channels at a glance

| Channel | Format | Platform | Needs | Phase | Auto-update |
| --- | --- | --- | --- | :---: | --- |
| GitHub Releases | `.dmg`, `.deb`, `.AppImage`, `.rpm` | all | nothing new | 0 | manual |
| Homebrew tap | cask | macOS | notarized `.dmg`, a tap repo | 1 | `brew upgrade` |
| Homebrew core cask | cask | macOS | notarization, some project history | 3 | `brew upgrade` |
| AppImage + zsync | `.AppImage` | Linux | `appimageupdate` info in the build | 1 | yes |
| APT repository | `.deb` | Debian, Ubuntu | signing key, hosting (Cloudsmith or R2) | 2 | `apt upgrade` |
| Snap Store | snap | Linux | `snapcraft.yaml`, store account | 2 | yes |
| Flathub | Flatpak | Linux | manifest, app id, permissions review | 2 | yes |
| AUR | `disklens-bin` | Arch | an AUR maintainer account | 2 | helper-dependent |
| COPR / `.rpm` | `.rpm` | Fedora, openSUSE | `rpm` bundle target | 3 | `dnf upgrade` |
| In-app updater | Tauri updater | all | signing key, `latest.json` | 3 | yes |
| Mac App Store | `.app` (sandboxed) | macOS | Apple Developer account, sandbox rework | not planned | yes |
| winget / Scoop | MSI | Windows | Windows support (planned) | later | yes |

## 4. Phase 0: a release pipeline we can trust

Do this before adding any channel.

1. **One version bump.** A script (`npm run bump -- 0.2.0`) updates the three version files, moves the `[Unreleased]` changelog section under the new version and commits. CI fails if the three files disagree.
2. **Fix the macOS matrix entry.** `release.yml` sets `targets: ${{ matrix.targets }}` and `args: ${{ matrix.args }}` inside the matrix itself, so both are probably empty. Set them to `aarch64-apple-darwin,x86_64-apple-darwin` and `--target universal-apple-darwin` so the `.dmg` really is universal, as the workflow comment and README say.
3. **Add Linux arm64.** Add an `ubuntu-22.04-arm` job for `.deb` and `.AppImage`. Raspberry Pi and ARM laptops are a growing share of Linux desktops.
4. **Add the `.rpm` bundle** (`--bundles deb,appimage,rpm`). Tauri supports it, and it unlocks Fedora and openSUSE.
5. **Publish `SHA256SUMS`** next to the artifacts. Every package manager below wants a hash.
6. **Draft, then publish by hand.** Keep releases as drafts. Publishing the release is the human gate. Downstream jobs run on `release: published`.
7. **Release notes from `CHANGELOG.md`.** Extract the matching section instead of the fixed sentence in `releaseBody`.
8. **Update `Cargo.toml`.** Its description still says "for macOS". It is also what appears in package metadata.
9. **Smoke test the artifacts.** A job that installs the `.deb` in a clean Ubuntu container and runs `disklens --version`, and launches the AppImage with `--appimage-extract-and-run`.

Done when: a tag produces a draft release with 5+ artifacts and checksums, and nothing is hand-edited.

## 5. Phase 1: reach the first users

### macOS: sign and notarize

- Join the Apple Developer Program (US$99 per year). Create a *Developer ID Application* certificate.
- Set the six `APPLE_*` secrets the workflow already reads. No workflow change is needed.
- Why first: every macOS channel (Homebrew, the in-app updater) works much better with a notarized app. Homebrew is moving away from casks that fail Gatekeeper, so plan on this being required.
- Then remove the "macOS first launch" section from the README.

### Homebrew tap (macOS)

- Create `nhamhv/homebrew-tap` with `Casks/disklens.rb` pointing at the release `.dmg` and its SHA-256.
- Install line for the README: `brew install --cask nhamhv/tap/disklens`.
- Automate the bump: a job in `release.yml` (on publish) opens a PR on the tap with the new version and hash.
- Add `zap` paths (`~/Library/Application Support/com.nhamhv.disklens`, `~/Library/Caches/com.nhamhv.disklens`) so `brew uninstall --zap` cleans up.

### AppImage with updates (Linux)

- Build with update information embedded so AppImageUpdate and tools like Gear Lever can update in place.
- List the app on appimage.github.io after the first stable release.

## 6. Phase 2: Linux package managers

Order by effort versus reach: Snap and Flatpak first (they cover most distros), then APT, then AUR.

### Snap

- Add `snap/snapcraft.yaml` (core22, base on Ubuntu 22.04 like CI) and build with `snapcore/action-build`, publish with `snapcore/action-publish` to the `edge` channel, then `stable`.
- **Confinement is the real decision.** DiskLens needs to read the whole disk and delete files.
  - *Strict* with `home` and `removable-media` works for the home folder only. It cannot scan `/` or other users' data.
  - *Classic* gives full access but needs a manual review by the Snap Store team, which is granted for tools that cannot work confined (disk analyzers are a common example).
- Plan: ship strict first with the scan limited to home, request classic with the justification above.
- Check that the freedesktop Trash and the tray icon (AppIndicator) work inside the chosen confinement.

### Flatpak (Flathub)

- Write `io.github.nhamhv.DiskLens.yml`. Flathub requires an app id whose domain you control; `io.github.<user>.<app>` is accepted for GitHub-hosted projects. The current identifier `com.nhamhv.disklens` is fine for `.deb` and AppImage but not for Flathub unless you own `nhamhv.com`.
- Runtime: `org.gnome.Platform` with the Rust and Node SDK extensions. Flathub builds offline, so vendor the crates (`cargo-sources.json` via `flatpak-cargo-generator`) and npm packages.
- Permissions: `--filesystem=host` (needed to analyze and clean anything outside the sandbox) and `--talk-name=org.kde.StatusNotifierWatcher` for the tray. Flathub reviews broad filesystem access; the justification is "a disk analyzer must read the disk".
- Known risk: inside the sandbox `/` is the runtime, and the host is under `/run/host`. The scan root, the protected-path list and Trash lookup assume host paths, so a Flatpak build needs its own path mapping in `platform/linux.rs`. Spike this before committing.

### APT repository

- Host a signed repository so Debian and Ubuntu users get `sudo apt install disklens` and updates.
- Simplest: Cloudsmith (free for open source) or `reprepro` output on Cloudflare R2, fronted by `apt.<domain>`. A job adds each new `.deb` and re-signs the index.
- Key handling: a dedicated GPG key stored in GitHub secrets; publish the public key at `/key.gpg`.
- Optional later: a Launchpad PPA, which needs a source package and is more work.

### AUR

- `disklens-bin` PKGBUILD that downloads the release `.deb` or AppImage. Update it from CI with a pushed commit to the AUR git repo (an SSH key in secrets).
- A source-built `disklens` package can follow once the build is stable on Arch.

## 7. Phase 3: polish

- **Homebrew core cask.** Submit to `Homebrew/homebrew-cask` once the app is notarized and has a track record (stars, releases). Keep the tap until the PR is merged.
- **`.rpm` via COPR.** Build from the release `.rpm`, or from source with a spec file.
- **In-app updater.** `tauri-plugin-updater` with a minisign key and a `latest.json` on the release. The app checks on launch (opt-in, like the existing launch count) and offers the update. This matters mostly for the `.dmg` and AppImage; package-manager installs should keep updating through their manager. Detect the install source and hide the updater for those.
- **Download page.** The Cloudflare Pages site (`site/`) detects the visitor's OS and shows the right button and install command, reading the latest release from the GitHub API at build time.

## 8. What we are not planning

- **Mac App Store.** It requires the App Sandbox, which blocks reading arbitrary folders and the Full Disk Access flow, and every deletion would need a user-granted security-scoped bookmark. That removes the core of the app. Revisit only if a reduced, folder-by-folder "lite" edition makes sense.
- **Windows channels** (winget, Scoop, MSI) until a `platform/windows.rs` exists.
- **Paid code signing for Linux.** Not applicable; GPG-signed repositories and store signing cover it.

## 9. Release checklist

1. Land changes; make sure CI is green on `main`.
2. `npm run bump -- X.Y.Z`, review the changelog section, commit.
3. `git tag vX.Y.Z && git push --tags`.
4. Wait for the draft release; download and try the `.dmg`, `.deb` and AppImage.
5. Publish the release. Downstream jobs open the tap PR, build the snap and update the AUR and APT repositories.
6. Merge the tap PR; watch the Flathub bot PR (once the Flathub app exists).
7. Update the website if the install instructions changed.

## 10. Secrets and accounts

| Item | Used for |
| --- | --- |
| Apple Developer Program, six `APPLE_*` secrets | macOS signing and notarization |
| `nhamhv/homebrew-tap` repo and a token that can push to it | Homebrew tap bumps |
| Snap Store account and `SNAPCRAFT_STORE_CREDENTIALS` | Snap publishing |
| Flathub repo under the `flathub` org | Flatpak |
| GPG key (private in secrets, public on the site) | APT repository |
| AUR account and SSH key | AUR package |
| minisign key pair | in-app updater |

## 11. Suggested order

1. Phase 0 (pipeline fixes, arm64, `.rpm`, checksums).
2. Apple signing and notarization, then the Homebrew tap.
3. Snap and Flatpak (spike the sandbox path mapping first).
4. APT repository and AUR.
5. In-app updater, Homebrew core, COPR, the download page.
