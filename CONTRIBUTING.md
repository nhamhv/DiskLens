# Contributing

Thanks for helping! Bug reports, translations and pull requests are all welcome.

## Setup

```sh
npm install
npm start          # runs `tauri dev`; uses the next free port if 1420 is busy
```

`npm start` and `npm run tauri dev` both work. They differ only on the port:

- `npm run tauri dev` uses port 1420 and stops with an error if it's taken.
- `npm start` picks a free port.

> **Full Disk Access in dev mode:** macOS gives the permission to the app that *launched* the binary, such as VS Code, iTerm or Terminal. It does not go to DiskLens itself. Grant it there if folders show as unreadable.

## Before opening a PR

```sh
npm run typecheck
npm run i18n:check
cd src-tauri && cargo test && cargo clippy
```

CI runs the same checks.

## Code style

- Write code that looks like the surrounding code. Keep components small. Put a feature's code in `src/features/<feature>/` and shared code in `src/components/` or `src/lib/`.
- Comments explain *why*, not *what*.
- Every Tauri command lives in `src-tauri/src/commands/<area>.rs` and is registered in `lib.rs`. If a command returns a struct, mirror it in `src/lib/types.ts`.
- Anything that deletes files must go through `delete_paths`, so the protected-path guard always applies.
- UI components come from [shadcn/ui](https://ui.shadcn.com): `npx shadcn add <component>`.

## Adding or improving a language

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/<code>.json`. Use an ISO 639-1 code such as `ko`, `fr` or `de`.
2. Translate the values. Leave the keys, the `{{placeholders}}` and tags like `<b>`, `<code>` and `<red>` as they are.
3. Plurals follow [i18next rules](https://www.i18next.com/translation-function/plurals):
   - English uses `_one` and `_other`.
   - Languages without plural forms (vi, zh, ja, ko…) only need `_other`.
   - Languages with more forms (ru, pl, ar…) add `_few`, `_many` and so on.
4. Register the language in `src/i18n/index.ts`: import the file and add it to `LANGUAGES`.
5. Run `npm run i18n:check`. It lists missing and unknown keys.

When you add a new string to the UI, add it to **all** locale files. If you can't translate it, copying the English text is fine. `i18n:check` will fail otherwise.

## Adding a developer cleanup rule

Built-in rules live in `src-tauri/rules/builtin.json` (format: `src-tauri/rules/schema.json`). Users can add their own in the app (Developer → Rules) without rebuilding.

1. Pick a unique `id` such as `<eco>.<thing>` and a `type`: `artifact`, `location`, `versioned` or `template`.
2. Set `safety` honestly:
   - `safe`: the tool recreates it by itself.
   - `rebuild`: it needs a command; put that in `restore`.
   - `caution`: it may hold something that can't be recreated (sessions, history, user settings).
3. Artifact rules need `markers` so they only match real projects. Use `gitIgnored: true` for generic names like `dist` or `build`.
4. If an app keeps the folder open, list it in `apps` so the item is blocked while it runs.
5. Labels are product and tool names, so they stay in English and aren't translated.
6. Run `cd src-tauri && cargo test`. `builtin_rules_are_valid` fails on any invalid rule.

## App icon

The source is `assets/icon.svg`. After editing it, regenerate every size in `src-tauri/icons/`:

```sh
npx tauri icon assets/icon.svg
rm -rf src-tauri/icons/android src-tauri/icons/ios   # macOS only
```

## Releases

Maintainers only:

1. Bump the version in **all** of these:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. Update `CHANGELOG.md`.
3. Tag the commit `vX.Y.Z` and push the tag.
4. The release workflow builds a universal `.dmg` and attaches it to a draft GitHub release.
