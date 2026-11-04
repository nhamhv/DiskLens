// Runs in the page before the app loads (see capture.mjs): fakes the Tauri backend with sample
// data so the real UI can be screenshotted without scanning anyone's disk. All numbers are made up.
(() => {
  const opts = window.__MOCK_OPTS__ || {};
  const G = 1e9, M = 1e6;
  const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
  const HOME = "/Users/alex";

  // ---------- sample file tree ----------
  const D = (name, children, o = {}) => ({ name, isDir: true, children, ...o });
  const L = (name, size, o = {}) => ({ name, isDir: true, leaf: true, size, ...o });
  const F = (name, size, days = 30, o = {}) => ({ name, isDir: false, size, modified: NOW - days * DAY, ...o });

  const tree = D("alex", [
    D("Library", [
      D("Caches", [
        L("Google", 4.6 * G, { delta: 0.9 * G }), L("com.apple.Safari", 2.9 * G), L("JetBrains", 3.8 * G, { delta: 0.6 * G }),
        L("Homebrew", 2.4 * G), L("Yarn", 2.1 * G), L("com.spotify.client", 2.0 * G, { delta: 0.5 * G }), L("pip", 1.3 * G), L("Firefox", 1.1 * G),
      ], { cat: "caches", safety: "safe", delta: 3.2 * G }),
      D("Developer", [
        D("Xcode", [L("DerivedData", 12.4 * G, { safety: "safe", delta: 2.1 * G }), L("iOS DeviceSupport", 8.1 * G, { safety: "review" })]),
        L("CoreSimulator", 21.7 * G, { safety: "review" }),
      ], { cat: "developer", safety: "review" }),
      D("Application Support", [
        L("Steam", 9.2 * G), L("Adobe", 6.4 * G), L("Google", 5.1 * G), L("Code", 4.2 * G), L("Slack", 2.6 * G),
      ], { cat: "appData", safety: "review" }),
      D("Containers", [L("com.docker.docker", 14.8 * G, { delta: 1.4 * G }), L("com.apple.mail", 1.6 * G)], { cat: "containers", safety: "review" }),
      L("Mail", 6.8 * G, { cat: "mail", safety: "review" }),
      L("Logs", 1.2 * G, { cat: "logs", safety: "safe" }),
    ], { delta: 4.1 * G }),
    D("Movies", [
      F("ProRes export - launch.mov", 12.4 * G, 410), F("Holiday 2025 4K.mp4", 8.1 * G, 290), F("Conference talk raw.mov", 6.3 * G, 520),
      F("Screen recording.mov", 3.4 * G, 700), L("Final Cut Library.fcpbundle", 11.6 * G), L("Clips", 5.5 * G),
    ], { cat: "media", safety: "review" }),
    D("Documents", [
      L("Windows 11.pvm", 24.3 * G), L("Design files", 6.4 * G), L("Invoices", 0.9 * G), F("Backup-2024.zip", 4.2 * G, 600), L("Research", 3.1 * G),
    ], { cat: "documents", safety: "review" }),
    D("Downloads", [
      F("ubuntu-24.04.1-desktop-amd64.iso", 6.1 * G, 220), F("Xcode_16.xip", 3.3 * G, 180), F("dataset-v3.tar.gz", 2.8 * G, 140),
      F("Figma.dmg", 0.2 * G, 90), F("node-v22.pkg", 0.1 * G, 60), L("Old installers", 3.9 * G),
    ], { cat: "downloads", safety: "review", delta: 1.8 * G }),
    D("Pictures", [L("Photos Library.photoslibrary", 21.5 * G), L("Wallpapers", 0.8 * G)], { cat: "media", safety: "review" }),
    D("Projects", [
      D("web-shop", [L("node_modules", 3.8 * G, { safety: "safe" }), L(".next", 1.2 * G, { safety: "safe" }), L("src", 0.05 * G), L(".git", 1.1 * G, { safety: "review" })]),
      D("mobile-app", [L("Pods", 2.4 * G, { safety: "safe" }), L("build", 6.2 * G, { safety: "safe" }), L("ios", 1.3 * G), L(".git", 0.9 * G, { safety: "review" })]),
      D("ml-notebooks", [L(".venv", 5.4 * G, { safety: "safe" }), L("data", 3.8 * G, { safety: "review" }), L("notebooks", 0.2 * G)]),
      D("rust-cli", [L("target", 3.6 * G, { safety: "safe" }), L("src", 0.01 * G)]),
    ], { cat: "developer", safety: "review", delta: 2.4 * G }),
    D("Music", [L("Logic", 6.2 * G), L("iTunes", 4.8 * G)], { cat: "media", safety: "review" }),
    L(".npm", 4.8 * G, { cat: "developer", safety: "safe" }),
    L(".cache", 6.1 * G, { cat: "caches", safety: "safe" }),
    L("Desktop", 3.2 * G, { cat: "documents", safety: "review" }),
    L(".Trash", 2.1 * G, { cat: "trash", safety: "safe" }),
  ], { cat: "other", safety: "unknown" });

  (function finish(n, path, cat, safety) {
    n.path = path;
    n.cat = n.cat || cat;
    n.safety = n.safety || safety;
    if (n.children) {
      n.children.forEach((c) => finish(c, `${path}/${c.name}`, n.cat, n.safety));
      n.size = n.children.reduce((s, c) => s + c.size, 0);
      n.items = n.items || n.children.reduce((s, c) => s + c.items, 1);
    } else {
      n.items = n.isDir ? Math.max(2, Math.round(n.size / (1.8 * M))) : 1;
    }
  })(tree, HOME, "other", "unknown");
  tree.delta = tree.children.reduce((s, c) => s + (c.delta || 0), 0);

  const find = (path, n = tree) => {
    if (n.path === path) return n;
    return (n.children || []).map((c) => (path.startsWith(c.path + "/") || path === c.path ? find(path, c) : null)).find(Boolean) || null;
  };
  const entry = (n) => ({ name: n.name, path: n.path, size: n.size, isDir: n.isDir, items: n.items, category: n.cat, safety: n.safety, modified: n.modified, delta: n.delta });
  const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };
  const root = () => ({ root: tree.path, size: tree.size, files: 1284330, errors: 0, scannedAt: NOW - 2400, elapsedMs: 0, cacheBytes: 31 * M, prevScannedAt: NOW - 6 * DAY });

  const listing = (path) => {
    const n = find(path) || { path, size: 0, items: 0, children: [] };
    const kids = [...(n.children || [])].sort((a, b) => b.size - a.size);
    return { path, size: n.size, items: n.items, entries: kids.map(entry), otherCount: 0, otherSize: 0, prevSize: n.size - (n.delta || 0) };
  };
  const largest = (path, limit, before) => {
    const out = [];
    walk(find(path) || tree, (n) => { if (!n.isDir || n.leaf) out.push(entry(n)); });
    return out.filter((e) => e.size > 0.15 * G && (!before || !e.modified || e.modified < before)).sort((a, b) => b.size - a.size).slice(0, limit);
  };
  const summary = (path) => {
    const top = find(path) || tree;
    const cats = {}, safety = {}, cleanup = [];
    const visit = (n, inSafe) => {
      if (!n.children) {
        cats[n.cat] = (cats[n.cat] || 0) + n.size;
        safety[n.safety] = (safety[n.safety] || 0) + n.size;
      }
      const safe = n.safety === "safe" && n.path !== `${HOME}/.Trash`;
      if (safe && !inSafe && n.size > 0.3 * G) cleanup.push(entry(n));
      (n.children || []).forEach((c) => visit(c, inSafe || safe));
    };
    visit(top, false);
    const rank = (o) => Object.entries(o).map(([key, size]) => ({ key, size })).sort((a, b) => b.size - a.size);
    cleanup.sort((a, b) => b.size - a.size);
    return { path, categories: rank(cats), safety: rank(safety), cleanup, cleanupCount: cleanup.length, cleanupSize: cleanup.reduce((s, e) => s + e.size, 0) };
  };
  const changes = () => {
    const out = [];
    walk(tree, (n) => { if (n.delta && n !== tree && !n.children) out.push(entry(n)); });
    return out.sort((a, b) => b.delta - a.delta);
  };

  // ---------- developer cleanup ----------
  const mt = (d) => NOW - d * DAY;
  const item = (o) => ({ ruleId: o.ruleId || o.label.toLowerCase().replace(/\W+/g, "-"), restore: null, description: null, custom: false, viewOnly: false, running: [], safety: "safe", category: "project", ...o });
  const proj = (name, ecos, lastActive, items, worktree = null) => ({
    path: `${HOME}/Projects/${name}`, name, ecos, lastActive: mt(lastActive), worktree,
    items: items.map(([dir, label, eco, size, safety, restore, mtime]) =>
      item({ path: `${HOME}/Projects/${name}/${dir}`, name: dir, label, eco, size: size * G, safety, restore, mtime: mt(mtime ?? lastActive) })),
  });
  const devReport = {
    projects: [
      proj("mobile-app", ["swift", "node"], 96, [["build", "Build output", "swift", 6.2, "safe", null], ["Pods", "CocoaPods", "swift", 2.4, "rebuild", "pod install"], ["node_modules", "Node modules", "node", 1.9, "rebuild", "npm install"]]),
      proj("web-shop", ["node"], 12, [["node_modules", "Node modules", "node", 3.8, "rebuild", "npm install"], [".next", "Next.js cache", "node", 1.2, "safe", null]]),
      proj("ml-notebooks", ["python"], 143, [[".venv", "Python virtualenv", "python", 5.4, "rebuild", "python -m venv .venv && pip install -r requirements.txt"], ["__pycache__", "Python bytecode", "python", 0.4, "safe", null]]),
      proj("rust-cli", ["rust"], 38, [["target", "Cargo build output", "rust", 3.6, "rebuild", "cargo build"]]),
      proj("landing-page", ["node"], 210, [["node_modules", "Node modules", "node", 1.4, "rebuild", "npm install"], ["dist", "Build output", "node", 0.3, "safe", null]]),
      proj("api-gateway", ["go"], 5, [["vendor", "Go vendor", "go", 0.8, "rebuild", "go mod vendor"]]),
    ],
    items: [
      ["sdk", "Android SDK system images", "android", `${HOME}/Library/Android/sdk/system-images`, 8.2, "caution", "sdkmanager --install", 150],
      ["sdk", "Rust toolchains (old)", "rust", `${HOME}/.rustup/toolchains/1.74-aarch64-apple-darwin`, 1.6, "rebuild", "rustup toolchain install 1.74", 320],
      ["sdk", "Xcode iOS DeviceSupport", "xcode", `${HOME}/Library/Developer/Xcode/iOS DeviceSupport`, 8.1, "safe", null, 60],
      ["caches", "Gradle caches", "java", `${HOME}/.gradle/caches`, 5.6, "safe", null, 14],
      ["caches", "npm cache", "node", `${HOME}/.npm/_cacache`, 4.8, "safe", null, 3],
      ["caches", "Cargo registry", "rust", `${HOME}/.cargo/registry`, 3.1, "safe", null, 9],
      ["caches", "Homebrew downloads", "brew", `${HOME}/Library/Caches/Homebrew`, 2.4, "safe", null, 20],
      ["caches", "pip cache", "python", `${HOME}/Library/Caches/pip`, 1.3, "safe", null, 11],
      ["caches", "Xcode DerivedData", "xcode", `${HOME}/Library/Developer/Xcode/DerivedData`, 12.4, "safe", null, 2],
      ["ide", "JetBrains caches", "jetbrains", `${HOME}/Library/Caches/JetBrains`, 3.8, "safe", null, 4],
      ["ide", "VS Code cached data", "vscode", `${HOME}/Library/Application Support/Code/CachedData`, 1.1, "safe", null, 8],
      ["ai", "Ollama models", "ai", `${HOME}/.ollama/models`, 18.4, "caution", "ollama pull <model>", 30],
      ["ai", "Hugging Face hub", "ai", `${HOME}/.cache/huggingface/hub`, 12.7, "rebuild", "huggingface-cli download <repo>", 45],
      ["ai", "Claude Code logs", "ai", `${HOME}/.claude/projects`, 0.9, "safe", null, 1],
      ["old", "Node 16.20 (nvm)", "node", `${HOME}/.nvm/versions/node/v16.20.2`, 0.4, "rebuild", "nvm install 16", 400],
      ["old", "Python 3.9 (pyenv)", "python", `${HOME}/.pyenv/versions/3.9.18`, 0.7, "rebuild", "pyenv install 3.9.18", 520],
    ].map(([category, label, eco, path, size, safety, restore, days]) => item({ category, label, eco, path, name: path.split("/").pop(), size: size * G, safety, restore, mtime: mt(days) })),
    warnings: [],
    rules: { path: `${HOME}/.config/disklens/rules.json`, mtime: null, builtin: 142, custom: 0, disabled: 0 },
    elapsedMs: 2840, scannedAt: NOW - 600,
  };

  // ---------- photos ----------
  const svg = (a, b, blur, label) => "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="${blur}"/></filter></defs><rect width="400" height="300" fill="url(#g)"/><g filter="url(#b)"><circle cx="130" cy="120" r="55" fill="rgba(255,255,255,.55)"/><rect x="190" y="150" width="150" height="90" rx="14" fill="rgba(0,0,0,.28)"/><path d="M0 260 Q120 190 240 245 T400 220 V300 H0Z" fill="rgba(0,0,0,.35)"/></g>${label ? `<rect x="24" y="24" width="352" height="30" rx="6" fill="rgba(255,255,255,.85)"/><rect x="24" y="66" width="220" height="14" rx="4" fill="rgba(255,255,255,.6)"/><rect x="24" y="92" width="300" height="14" rx="4" fill="rgba(255,255,255,.6)"/>` : ""}</svg>`);
  const palettes = [["#f59e0b", "#7c3aed"], ["#06b6d4", "#1e3a8a"], ["#f43f5e", "#fb923c"], ["#10b981", "#0f172a"], ["#a78bfa", "#0ea5e9"], ["#facc15", "#dc2626"], ["#34d399", "#2563eb"], ["#fb7185", "#4c1d95"]];
  const photo = (name, size, days, i, sharp) => ({ path: `${HOME}/Pictures/${name}`, name, size: size * M, modified: mt(days), sharpness: sharp ?? null, i });
  const blurry = Array.from({ length: 14 }, (_, i) => photo(`IMG_${4312 + i * 7}.HEIC`, 2.4 + (i % 5) * 0.7, 20 + i * 11, i, 8 + (i % 4) * 6));
  const shots = Array.from({ length: 18 }, (_, i) => photo(`Screenshot 2026-0${1 + (i % 9)}-${10 + i} at 10.${14 + i}.22.png`, 0.4 + (i % 4) * 0.3, 5 + i * 9, i + 3));
  const similar = Array.from({ length: 5 }, (_, g) => [0, 1, 2].map((k) => photo(`IMG_${6100 + g * 10 + k}.HEIC`, 3.8 - k * 0.5, 40 + g * 25 + k, g + k * 0.05 + 10, 140 - k * 30)));
  const photoReport = { scanned: 18432, truncated: false, blurry, screenshots: shots, similar };
  const thumbs = new Map();
  [...blurry, ...shots, ...similar.flat()].forEach((p) => thumbs.set(p.path, p));

  // ---------- applications ----------
  const apps = [
    ["Xcode", "com.apple.dt.Xcode", "16.1", 3, "appstore", 38.2, 12.4], ["Docker", "com.docker.docker", "4.34.2", 2, "sparkle", 2.1, 14.8], ["Adobe Photoshop 2025", "com.adobe.Photoshop", "26.0", 400, "other", 5.2, 6.4],
    ["Final Cut Pro", "com.apple.FinalCut", "10.8", 20, "appstore", 3.9, 11.6], ["Steam", "com.valvesoftware.steam", "1730", 150, "other", 0.4, 9.2], ["Android Studio", "com.google.android.studio", "2024.2", 12, "other", 1.6, 4.4],
    ["Visual Studio Code", "com.microsoft.VSCode", "1.94", 1, "sparkle", 0.4, 4.2], ["Slack", "com.tinyspeck.slackmacgap", "4.40", 1, "appstore", 0.3, 2.6], ["Figma", "com.figma.Desktop", "124.3", 2, "sparkle", 0.5, 1.2],
    ["Spotify", "com.spotify.client", "1.2.50", 4, "other", 0.6, 2.0], ["Zoom", "us.zoom.xos", "6.2", 45, "other", 0.5, 1.1], ["Notion", "notion.id", "4.1", 8, "other", 0.4, 0.9],
  ].map(([name, bundleId, version, days, source, bundle, data], i) => ({ path: `/Applications/${name}.app`, name, bundleId, version, build: version, lastUsed: days > 300 ? null : mt(days), source, _b: bundle * G, _d: data * G }));
  const appIcon = (name, i) => {
    const [a, b] = palettes[i % palettes.length];
    return "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect x="6" y="6" width="116" height="116" rx="28" fill="url(#g)"/><text x="64" y="84" font-family="Helvetica,Arial" font-size="58" font-weight="700" fill="white" text-anchor="middle">${name[0]}</text></svg>`);
  };

  // ---------- fake Tauri ----------
  const listeners = {};
  let nextId = 1;
  const emit = (event, payload) => (listeners[event] || []).forEach(({ handler, id }) => window[`_${handler}`] && window[`_${handler}`]({ event, id, payload }));
  const report = {
    body: "**What happened?**\n<!-- Describe the problem and what you expected. -->\n\n**Diagnostics**\n- DiskLens: 0.1.0\n- OS: macOS 14.5 (aarch64)\n- Crash logs on this machine: 1\n\n<details><summary>Latest crash log (crash-1760500000-panic.log)</summary>\n\n```\nDiskLens 0.1.0\nmacOS 14.5 (aarch64)\n2026-10-15T02:26:40Z\n\nindex out of bounds: the len is 3 but the index is 7\nat src/scanner.rs:212\nthread: rayon-worker-2\n```\n</details>\n",
    url: "https://github.com/nhamhv/DiskLens/issues/new",
  };

  const handlers = {
    platform_features: () => ({ os: "macos", apps: true, fullDiskAccess: true, hiddenSpace: true, quickLook: true, heic: true }),
    disk_info: () => ({ total: 994 * G, free: 212 * G }),
    list_caches: () => [
      { ...root(), scannedAt: NOW - 2400 },
      { root: "/", size: 781 * G, files: 4_902_117, errors: 214, scannedAt: NOW - 3 * DAY, elapsedMs: 0, cacheBytes: 118 * M },
      { root: `${HOME}/Projects`, size: 64.2 * G, files: 612_040, errors: 0, scannedAt: NOW - 9 * DAY, elapsedMs: 0, cacheBytes: 22 * M },
    ],
    has_full_disk_access: () => true,
    hidden_space: () => ({ snapshots: ["2026-10-12-081500", "2026-10-13-081500", "2026-10-14-081500"], purgeable: 14.2 * G }),
    trash_contents: () => [{ name: ".Trash", path: `${HOME}/.Trash/old`, size: 2.1 * G, isDir: true, items: 412 }],
    telemetry_status: () => ({ available: true, consent: opts.consent === undefined ? true : opts.consent }),
    scan_threads: () => ({ cpus: 10, min: 1, low: 2, balanced: 5, high: 10, fast: 20 }),
    load_cache: ({ path }) => (path === tree.path ? root() : null),
    list_children: ({ path }) => listing(path),
    largest_files: ({ path, limit, modifiedBefore }) => largest(path, limit, modifiedBefore),
    scan_changes: () => changes(),
    scan_summary: ({ path }) => summary(path),
    list_apps: () => apps.map(({ _b, _d, ...a }) => a),
    app_icon: ({ path }) => { const i = apps.findIndex((a) => a.path === path); return appIcon(apps[i].name, i); },
    app_footprints: ({ paths }) => {
      setTimeout(() => paths.forEach((p) => { const a = apps.find((x) => x.path === p); emit("app-footprint", { path: p, bundle: a._b, data: [{ path: `${HOME}/Library/Application Support/${a.name}`, size: a._d * 0.7, isDir: true }, { path: `${HOME}/Library/Caches/${a.bundleId}`, size: a._d * 0.3, isDir: true }] }); }), 50);
    },
    check_app_updates: ({ paths }) => paths.map((p, i) => ({ path: p, latest: i % 4 === 1 ? "99.0" : null, available: i % 4 === 1, url: null, error: null })),
    dev_cached_report: () => devReport,
    dev_scan: () => devReport,
    photos_scan: () => photoReport,
    photo_thumb: ({ path }) => { const p = thumbs.get(path); if (!p) return null; const blurred = blurry.includes(p); const shot = shots.includes(p); const [a, b] = palettes[Math.floor(p.i) % palettes.length]; return svg(a, b, blurred ? 9 : 0, shot); },
    issue_report: () => report,
    list_crash_logs: () => [{ name: "crash-1760500000-panic.log", modified: NOW - 3600, size: 2400 }],
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) { const id = Math.floor(Math.random() * 1e9); window[`_${id}`] = (...a) => { if (once) delete window[`_${id}`]; return cb && cb(...a); }; return id; },
    unregisterCallback(id) { delete window[`_${id}`]; },
    convertFileSrc: (p) => p,
    async invoke(cmd, args = {}) {
      if (cmd === "plugin:event|listen") { const id = nextId++; (listeners[args.event] ||= []).push({ handler: args.handler, id }); return id; }
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "plugin:path|resolve_directory") return HOME;
      if (handlers[cmd]) return handlers[cmd](args);
      if (cmd.startsWith("plugin:")) return nextId++;
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
