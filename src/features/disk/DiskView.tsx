import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ChevronRight, CircleDot, History, LayoutGrid, Loader2, Palette, RefreshCw, ShieldCheck, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import type { DiskInfo, Entry, Listing, Progress, ScanMeta, Speed, Summary } from "@/lib/types";
import { SAFETY_COLORS, SAFETY_LEVELS, safetyLabel } from "@/lib/safety";
import { baseName, formatBytes, formatDelta, joinPath, parentDir, timeAgo } from "@/lib/format";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { runDelete } from "@/lib/delete";
import { Button } from "@/components/ui/button";
import { DeleteDialog, type DeleteRequest } from "@/components/DeleteDialog";
import { SpeedPicker } from "@/components/SpeedPicker";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MAX_TILES, Treemap, type ColorMode } from "./Treemap";
import { Bubbles } from "./Bubbles";
import { Sidebar, type Tab } from "./Sidebar";
import { EntryMenu, type EntryActions } from "./EntryMenu";
import { rootLabel } from "./rootLabel";

/** A cached result older than this gets a "may be outdated" banner with a rescan button. */
const STALE_AFTER_SECS = 24 * 60 * 60;
/** `scan-entry` events arrive in bursts (hundreds of tiny top-level items); render them in batches. */
const ENTRY_FLUSH_MS = 250;
const NO_ENTRIES: Entry[] = [];
/** "Old" in the largest-files filter: untouched for a year. */
const OLD_AFTER_SECS = 365 * 24 * 60 * 60;

type Layout = "treemap" | "bubbles";

/** A string setting kept in localStorage, falling back to `fallback` for unknown values. */
function useStored<T extends string>(key: string, values: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    const v = localStorage.getItem(key) as T | null;
    return v && values.includes(v) ? v : fallback;
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      localStorage.setItem(key, v);
    },
    [key],
  );
  return [value, set] as const;
}

interface Props {
  root: string;
  home: string;
  speed: Speed;
  onSpeed(s: Speed): void;
  onExit(): void;
}

/**
 * Browses one scanned root. On mount it opens the cached result for `root` if there is one,
 * otherwise starts a scan. Remount (via `key`) to switch roots.
 */
export function DiskView({ root, home, speed, onSpeed, onExit }: Props) {
  const { t } = useTranslation();
  const [cwd, setCwd] = useState(root);
  /** Treemap paging: how many of `dir`'s biggest items are skipped after clicking "N items". */
  const [page, setPage] = useState({ dir: root, offset: 0 });
  const [scanning, setScanning] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [partial, setPartial] = useState<Entry[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [largest, setLargest] = useState<Entry[]>([]);
  const [oldOnly, setOldOnly] = useState(false);
  const [changes, setChanges] = useState<Entry[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<Tab>("current");
  const [layout, setLayout] = useStored<Layout>("diskLayout", ["treemap", "bubbles"], "treemap");
  const [colors, setColors] = useStored<ColorMode>("diskColors", ["kind", "safety"], "kind");
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [version, setVersion] = useState(0); // bump to reload listing after scan/delete
  const [staleDismissed, setStaleDismissed] = useState(false);
  const scanningRef = useRef(false);
  const pendingEntries = useRef<Entry[]>([]);
  const flushTimer = useRef<number | undefined>(undefined);

  const showError = useCallback((e: unknown) => toast.error(String(e)), []);
  const refreshDisk = useCallback(() => {
    api.diskInfo().then(setDisk).catch(() => {});
  }, []);

  const flushEntries = useCallback(() => {
    flushTimer.current = undefined;
    const batch = pendingEntries.current;
    pendingEntries.current = [];
    if (batch.length) setPartial((p) => [...p, ...batch]);
  }, []);

  const scan = useCallback(async () => {
    setCwd(root);
    setPage({ dir: root, offset: 0 });
    pendingEntries.current = [];
    setPartial([]);
    setListing(null);
    setLargest([]);
    setProgress(null);
    setMeta(null);
    setScanning(true);
    scanningRef.current = true;
    refreshDisk();
    try {
      await api.startScan(root, speed);
    } catch (e) {
      setScanning(false);
      scanningRef.current = false;
      showError(e);
    }
  }, [root, speed, refreshDisk, showError]);

  // Scan events, plus the initial open. `alive` guards against StrictMode's double mount.
  useEffect(() => {
    let alive = true;
    const unlisten = [
      listen<Progress>("scan-progress", (e) => setProgress(e.payload)),
      listen<Entry>("scan-entry", (e) => {
        if (parentDir(e.payload.path) !== root) return;
        pendingEntries.current.push(e.payload);
        flushTimer.current ??= window.setTimeout(flushEntries, ENTRY_FLUSH_MS);
      }),
      listen<ScanMeta>("scan-done", (e) => {
        if (e.payload.root !== root) return;
        setScanning(false);
        scanningRef.current = false;
        setMeta(e.payload);
        setVersion((v) => v + 1);
      }),
    ];
    refreshDisk();
    api
      .loadCache(root)
      .catch(() => null)
      .then((cached) => {
        if (!alive) return;
        if (!cached) return scan();
        setMeta(cached);
        setVersion((v) => v + 1);
      });
    return () => {
      alive = false;
      window.clearTimeout(flushTimer.current);
      if (scanningRef.current) api.cancelScan();
      unlisten.forEach((p) => p.then((off) => off()));
    };
    // Mount-only: `scan` changes with `speed`, which must not restart anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const stopScan = useCallback(async () => {
    await api.cancelScan();
    setScanning(false);
    scanningRef.current = false;
    // Fall back to the previous result for this folder, if any.
    const cached = await api.loadCache(root).catch(() => null);
    if (cached) {
      setMeta(cached);
      setVersion((v) => v + 1);
      toast(t("disk.scanStoppedPrevious", { when: timeAgo(cached.scannedAt) }));
    } else {
      onExit();
      toast(t("disk.scanStopped"));
    }
  }, [root, onExit, t]);

  /** Rescans one folder inside the current scan and splices the result in; the root means a full scan. */
  const rescanPath = useCallback(
    async (path: string) => {
      if (path === root) return scan();
      setRescanning(true);
      const name = baseName(path);
      const id = toast.loading(t("disk.rescanningName", { name }));
      try {
        await api.rescanFolder(path, speed);
        setVersion((v) => v + 1);
        refreshDisk();
        toast.success(t("disk.rescanned", { name }), { id });
      } catch (e) {
        toast.error(String(e), { id });
      } finally {
        setRescanning(false);
      }
    },
    [root, speed, scan, refreshDisk, t],
  );

  // While scanning, the root shows live `scan-entry` tiles; folders below it are read from the
  // top-level folders that already finished. Errors then are transient (the tree is being
  // assembled) and `scan-done` reloads anyway, so they stay quiet.
  const canQuery = scanning ? cwd !== root : !!meta;
  const queryError = useCallback((e: unknown) => scanningRef.current || showError(e), [showError]);

  useEffect(() => {
    if (!canQuery) return;
    api.listChildren(cwd).then(setListing).catch(queryError);
  }, [cwd, canQuery, version, queryError]);

  useEffect(() => {
    if (!canQuery || tab !== "largest") return;
    api
      .largestFiles(cwd, 200, oldOnly ? Math.floor(Date.now() / 1000) - OLD_AFTER_SECS : undefined)
      .then(setLargest)
      .catch(queryError);
  }, [cwd, canQuery, tab, oldOnly, version, queryError]);

  const hasPrevious = !!meta?.prevScannedAt;
  useEffect(() => {
    if (!canQuery || tab !== "changes" || !hasPrevious) return setChanges(null);
    api.scanChanges(cwd).then(setChanges).catch(queryError);
  }, [cwd, canQuery, tab, hasPrevious, version, queryError]);

  // Walks the whole subtree, so it only runs while the cleanup or summary tab is open.
  const wantSummary = canQuery && (tab === "cleanup" || tab === "summary");
  useEffect(() => {
    setSummary(null);
    if (!wantSummary) return;
    let alive = true;
    api
      .scanSummary(cwd)
      .then((s) => alive && setSummary(s))
      .catch(queryError);
    return () => {
      alive = false;
    };
  }, [cwd, wantSummary, version, queryError]);

  // Kept referentially stable between progress ticks, so the treemap and list only re-render
  // when the entries themselves change.
  const sortedPartial = useMemo(() => [...partial].sort((a, b) => b.size - a.size), [partial]);
  const showPartial = scanning && cwd === root;
  const folderEntries = showPartial ? sortedPartial : (listing?.entries ?? NO_ENTRIES);
  const otherCount = showPartial ? 0 : (listing?.otherCount ?? 0);
  const otherSize = showPartial ? 0 : (listing?.otherSize ?? 0);
  // Past the first page, the treemap and list show only the items after `offset`.
  const offset = page.dir === cwd && page.offset < folderEntries.length ? page.offset : 0;
  const entries = useMemo(() => (offset ? folderEntries.slice(offset) : folderEntries), [folderEntries, offset]);
  const paged = offset > 0;
  const size = showPartial
    ? (progress?.bytes ?? 0)
    : paged
      ? entries.reduce((sum, e) => sum + e.size, otherSize)
      : (listing?.size ?? 0);
  const items = showPartial ? partial.length : paged ? entries.length + otherCount : (listing?.items ?? 0);
  const openRest = useCallback(() => setPage({ dir: cwd, offset: offset + MAX_TILES }), [cwd, offset]);
  const canOpenRest = entries.length > MAX_TILES;

  const navigate = useCallback(
    (path: string) => {
      // While scanning, only folders whose size is final can be opened.
      const top = path.slice(root.length).split("/").find(Boolean);
      if (scanning && top && !partial.some((e) => e.path === joinPath(root, top))) toast(t("disk.stillScanning"));
      else {
        setCwd(path);
        setPage({ dir: path, offset: 0 });
      }
    },
    [scanning, root, partial, t],
  );

  const goUp = useCallback(() => {
    if (paged) setPage({ dir: cwd, offset: Math.max(0, offset - MAX_TILES) });
    else if (cwd !== root) navigate(parentDir(cwd));
  }, [cwd, root, navigate, paged, offset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Backspace" && !confirm && !(e.target instanceof HTMLInputElement)) goUp();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goUp, confirm]);

  const doDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    const res = await runDelete(confirm);
    setDeleting(false);
    setConfirm(null);
    if (res) {
      setVersion((v) => v + 1);
      refreshDisk();
    }
  };

  const askDelete = useCallback(
    (entries: Entry[], permanent: boolean) => {
      if (scanning) toast(t("disk.waitForScan"));
      else if (entries.length) setConfirm({ entries, permanent });
    },
    [scanning, t],
  );

  const actions: EntryActions = useMemo(
    () => ({
      onOpen: (e) => {
        if (!e.isDir) return;
        // A bundle's contents weren't kept by the scan; read them now.
        if (e.collapsed && scanning) return toast(t("disk.waitForScan"));
        navigate(e.path);
        if (e.collapsed) rescanPath(e.path);
      },
      onCopy: (e) => api.copyPath(e.path).then(() => toast.success(t("disk.pathCopied"), { description: e.path })),
      onReveal: (e) => api.revealInFinder(e.path).catch(showError),
      onRescan: (e) => {
        if (scanning) toast(t("disk.waitForScan"));
        else rescanPath(e.path);
      },
      onTrash: (entries) => askDelete(entries, false),
      onDelete: (entries) => askDelete(entries, true),
      onPreview: platform.quickLook ? (entries) => api.quickLook(entries.map((e) => e.path)).catch(showError) : undefined,
      locked: scanning,
    }),
    [navigate, showError, scanning, rescanPath, askDelete, t],
  );

  const crumbs = useMemo(() => {
    const list = [{ label: rootLabel(root, home), path: root }];
    let acc = root;
    for (const part of cwd.slice(root.length).split("/").filter(Boolean)) {
      acc = joinPath(acc, part);
      list.push({ label: part, path: acc });
    }
    if (paged) list.push({ label: t("disk.smallerItems", { count: items }), path: `${cwd}#page` });
    return list;
    // `t` re-runs this when the language changes, since rootLabel translates.
  }, [root, cwd, home, paged, items, t]);

  const used = disk ? disk.total - disk.free : 0;
  const chart = useMemo(() => {
    const Chart = layout === "bubbles" ? Bubbles : Treemap;
    return (
      <EntryMenu entries={entries} {...actions}>
        <Chart
          entries={entries}
          otherCount={otherCount}
          otherSize={otherSize}
          colors={colors}
          onOpen={actions.onOpen}
          onOpenRest={canOpenRest ? openRest : undefined}
        />
      </EntryMenu>
    );
  }, [layout, colors, entries, actions, otherCount, otherSize, canOpenRest, openRest]);
  const stale = !scanning && !staleDismissed && !!meta && Date.now() / 1000 - meta.scannedAt > STALE_AFTER_SECS;

  return (
    <div className="flex h-full">
      <Sidebar
        listKey={`${cwd}#${offset}#${tab}`}
        tab={tab}
        onTab={setTab}
        items={items}
        size={size}
        entries={entries}
        largest={showPartial ? NO_ENTRIES : largest}
        changes={hasPrevious && !showPartial ? changes : null}
        oldOnly={oldOnly}
        onOldOnly={setOldOnly}
        summary={summary}
        colors={colors}
        actions={actions}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <Button size="sm" variant="outline" onClick={onExit} title={t("disk.backHint")}>
            <ArrowLeft /> {t("common.home")}
          </Button>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-sm">
            {crumbs.map((c, i) => (
              <span key={c.path} className={cn("flex items-center", i < crumbs.length - 1 && "min-w-0 shrink")}>
                {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
                <button
                  className={cn(
                    "truncate rounded px-1.5 py-0.5 hover:bg-accent",
                    i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => i < crumbs.length - 1 && navigate(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>

          <ToggleGroup type="single" size="sm" variant="outline" value={layout} onValueChange={(v) => v && setLayout(v as Layout)}>
            <ToggleGroupItem value="treemap" title={t("view.treemap")} aria-label={t("view.treemap")}>
              <LayoutGrid />
            </ToggleGroupItem>
            <ToggleGroupItem value="bubbles" title={t("view.bubbles")} aria-label={t("view.bubbles")}>
              <CircleDot />
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup type="single" size="sm" variant="outline" value={colors} onValueChange={(v) => v && setColors(v as ColorMode)}>
            <ToggleGroupItem value="kind" title={t("view.colorKind")} aria-label={t("view.colorKind")}>
              <Palette />
            </ToggleGroupItem>
            <ToggleGroupItem value="safety" title={t("view.colorSafety")} aria-label={t("view.colorSafety")}>
              <ShieldCheck />
            </ToggleGroupItem>
          </ToggleGroup>

          {scanning ? (
            <Button size="sm" variant="destructive" onClick={stopScan}>
              <Square className="fill-current" /> {t("disk.stop")}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => rescanPath(cwd)} disabled={rescanning || !meta}>
              <RefreshCw className={cn(rescanning && "animate-spin")} />
              {rescanning ? t("disk.rescanning") : cwd === root ? t("disk.rescanAll") : t("disk.rescanFolder")}
            </Button>
          )}
        </header>

        <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3 text-xs text-muted-foreground tabular-nums">
          {scanning ? (
            <span className="flex min-w-0 items-center gap-2" title={progress?.current}>
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              <span className="shrink-0 text-foreground">
                {t("common.files", { count: progress?.files ?? 0 })} · {formatBytes(progress?.bytes ?? 0)}
              </span>
              <span className="truncate font-mono">{progress?.current}</span>
            </span>
          ) : (
            meta && (
              <span className="truncate">
                {t("disk.scanned", { when: timeAgo(meta.scannedAt) })} · {t("common.files", { count: meta.files })}
                {meta.elapsedMs > 0 && ` · ${(meta.elapsedMs / 1000).toFixed(1)}s`}
                {!paged && listing?.prevSize != null && meta.prevScannedAt && (
                  <button
                    className={cn("hover:underline", listing.size >= listing.prevSize ? "text-amber-500" : "text-emerald-500")}
                    title={t("disk.sincePreviousHint")}
                    onClick={() => setTab("changes")}
                  >
                    {" · "}
                    {t("disk.sincePrevious", { delta: formatDelta(listing.size - listing.prevSize), when: timeAgo(meta.prevScannedAt) })}
                  </button>
                )}
                {meta.errors > 0 && (
                  <span title={t("disk.unreadableHint")}> · {t("disk.unreadable", { count: meta.errors })}</span>
                )}
              </span>
            )
          )}
          <span className="flex-1" />
          <SpeedPicker speed={speed} onChange={onSpeed} />
          {disk && (
            <span className="flex shrink-0 items-center gap-2" title={t("summary.note")}>
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${(used / disk.total) * 100}%` }} />
              </span>
              {formatBytes(used)} / {formatBytes(disk.total)}
            </span>
          )}
        </div>

        {stale && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 text-xs text-amber-700 dark:text-amber-400">
            <History className="size-3.5 shrink-0" />
            <span className="truncate">{t("disk.stale", { when: timeAgo(meta.scannedAt) })}</span>
            <span className="flex-1" />
            <Button size="xs" variant="outline" onClick={scan}>
              <RefreshCw /> {t("disk.rescanAll")}
            </Button>
            <Button size="icon-xs" variant="ghost" title={t("common.dismiss")} onClick={() => setStaleDismissed(true)}>
              <X />
            </Button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 p-3">{chart}</div>

        {colors === "safety" && (
          <div className="flex h-8 shrink-0 items-center gap-4 border-t px-3 text-xs text-muted-foreground">
            {SAFETY_LEVELS.map((level) => (
              <span key={level} className="flex items-center gap-1.5" title={t(`safety.${level}Hint`)}>
                <span className="size-2.5 rounded-full" style={{ background: SAFETY_COLORS[level] }} />
                {safetyLabel(level)}
              </span>
            ))}
          </div>
        )}
      </main>

      <DeleteDialog request={confirm} busy={deleting} onCancel={() => setConfirm(null)} onConfirm={doDelete} />
    </div>
  );
}
