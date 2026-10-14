# Notes for AI coding agents

Read ARCHITECTURE.md first. Rules that are easy to miss:

- **Stack:**
  - Tauri 2 (Rust)
  - React 19 + TypeScript
  - Vite
  - Tailwind v4 + shadcn/ui (radix-nova style)
  - lucide-react icons
  - sonner toasts
  - i18next
- **Strings:** every user-visible string uses `t("section.key")`. Add each new key to **every** file in `src/i18n/locales/` (en, vi, zh, ja, ko, es, fr, de, it, pt, ru, id). Then run `npm run i18n:check`.
- **Deleting files:** always go through the `delete_paths` command, which applies the `is_protected` guard. Never call `rm` or `fs::remove*` from new code paths. In the UI, permanent delete must stay two-step (`DeleteDialog`).
- **New Tauri commands:**
  - Put the command in `src-tauri/src/commands/<area>.rs`.
  - Register it in `lib.rs`.
  - Add a typed wrapper to `src/lib/api.ts`.
  - Mirror any returned struct in `src/lib/types.ts`. Rust uses `rename_all = "camelCase"`.
- **OS-specific code:** only in `src-tauri/src/platform/{macos,linux}.rs`, with the same function set in each; callers never use `cfg`. If a feature is missing on an OS, add a flag to `platform::Features` and hide it in the UI via `src/lib/platform.ts`. Update the feature table in README.md.
- **Heavy filesystem work:** run it in `state::blocking(...)`. Use `build_pool(speed)` when the user's speed setting should apply.
- **Dev port:** `npm start` picks a free port and passes it to both Vite (`PORT`) and Tauri (`--config devUrl`). Never set Vite's `strictPort: false`. A drifting port makes the Tauri window load a blank page.
- **Rust toolchain:** on Apple Silicon, check `rustc -vV`. An x86_64 host toolchain builds Intel binaries that run under Rosetta.
- **Checks before you finish:**
  - `npm run build`
  - `npm run i18n:check`
  - `cd src-tauri && cargo test`
- **Worktrees:** `src-tauri/target` is several GB. When working in a git worktree, set `CARGO_TARGET_DIR` to a shared path, or delete `target/` when you are done.
