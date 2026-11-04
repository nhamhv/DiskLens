import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  Code,
  FileCog,
  FolderGit2,
  GitBranch,
  History,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import type { DevItem, DevProgress, DevReport, Entry, Safety, Speed, WorktreeStatus } from "@/lib/types";
import { baseName, formatBytes, formatCount, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runDelete } from "@/lib/delete";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteDialog, type DeleteRequest } from "@/components/DeleteDialog";
import { ItemRow } from "./ItemRow";
import { ProjectRow, WorktreeRow } from "./Rows";
import { RulesView, hasRulesDraft } from "./RulesView";
import {
  TABS,
  eco,
  idleDays,
  itemPasses,
  selectable,
  sum,
  tildify,
  topLevel,
  visibleItems,
  visibleProjects,
  visibleWorktrees,
  withoutPaths,
  type Age,
  type Filters,
  type Tab,
} from "./model";

const TAB_ICON: Record<Tab, LucideIcon> = {
  projects: FolderGit2,
  sdk: Wrench,
  caches: Package,
  ide: Code,
  ai: Bot,
  old: History,
  worktrees: GitBranch,
};

const SAFETIES: Safety[] = ["safe", "rebuild", "caution"];
const AGES: Age[] = [0, 30, 90, 365];
const DEFAULT_FILTERS: Filters = { eco: [], safety: ["safe", "rebuild"], age: 0 };

/** One filter as a button showing its current value; the options open in a menu. */
function FilterMenu({ label, value, title, children }: { label: string; value: ReactNode; title?: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" title={title} className="shrink-0 gap-1.5 font-normal">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-foreground">{value}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      {/* Wider than the button, which can be short ("Age: Any age"), so counts and hints fit. */}
      <DropdownMenuContent align="end" className="w-auto min-w-64 max-w-sm">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
/** "Select stale" never picks projects touched more recently than this. */
const STALE_DAYS = 90;

// Kept across visits so coming back is instant; Rescan re-reads the disk.
const memo = {
  report: null as DevReport | null,
  /** A scan still running after this screen was left. */
  pending: null as Promise<DevReport | null> | null,
  statuses: {} as Record<string, WorktreeStatus>,
};

function loadFolders(home: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("devFolders") ?? "null");
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  } catch {
    /* fall through */
  }
  return home ? [home] : [];
}

export function DevView({ home, speed, onBack }: { home: string; speed: Speed; onBack(): void }) {
  const { t } = useTranslation();
  const [folders, setFoldersState] = useState<string[]>(() => loadFolders(home));
  const [report, setReport] = useState<DevReport | null>(memo.report);
  const [statuses, setStatuses] = useState(memo.statuses);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<DevProgress | null>(null);
  const [tab, setTab] = useState<Tab>("projects");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const filtersChanged =
    filters.eco.length > 0 || filters.age !== 0 || filters.safety.length !== DEFAULT_FILTERS.safety.length || DEFAULT_FILTERS.safety.some((x) => !filters.safety.includes(x));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<"results" | "rules">("results");
  /** Rules saved in the editor since the last scan: rescan when leaving it. */
  const [rulesSaved, setRulesSaved] = useState(false);
  /** The rules file changed (in another editor) after the shown scan read it. */
  const [rulesStale, setRulesStale] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    memo.report = report;
    memo.statuses = statuses;
  }, [report, statuses]);

  /** Shows a scan's progress and result; the scan itself may have started on an earlier visit. */
  const follow = useCallback(async (p: Promise<DevReport | null>) => {
    setScanning(true);
    try {
      // null: stopped, or replaced by a newer scan — keep what's shown.
      const res = await p;
      if (res) {
        setReport(res);
        setStatuses({});
        setSelected(new Set());
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      if (memo.pending === p || !memo.pending) setScanning(false);
    }
  }, []);

  const scan = useCallback(
    (list: string[]) => {
      setProgress(null);
      const p = api.devScan(list, speed);
      memo.pending = p;
      // Lands in the memo even if this screen is left before the scan finishes.
      p.then((res) => {
        if (res) memo.report = res;
        if (res) memo.statuses = {};
      })
        .catch(() => {})
        .finally(() => {
          if (memo.pending === p) memo.pending = null;
        });
      return follow(p);
    },
    [speed, follow],
  );

  useEffect(() => {
    const off = listen<DevProgress>("dev-progress", (e) => setProgress(e.payload));
    return () => {
      off.then((fn) => fn());
    };
  }, []);

  // `home` arrives asynchronously on a cold start.
  useEffect(() => {
    if (started.current || !home) return;
    started.current = true;
    const list = loadFolders(home);
    setFoldersState(list);
    if (memo.pending) follow(memo.pending);
    else if (!memo.report)
      // Last session's result from disk; scan only when there is none.
      api
        .devCachedReport()
        .catch(() => null)
        .then((cached) => (cached ? setReport(cached) : scan(list)));
  }, [home, scan, follow]);

  const setFolders = (list: string[]) => {
    setFoldersState(list);
    localStorage.setItem("devFolders", JSON.stringify(list));
    scan(list);
  };

  const addFolder = async () => {
    const picked = await open({ directory: true, multiple: true });
    const list = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter((p) => !folders.includes(p));
    if (list.length) setFolders([...folders, ...list]);
  };

  const reportMtime = report?.rules.mtime;
  useEffect(() => {
    if (view !== "results" || reportMtime === undefined) return;
    const poll = () =>
      api
        .devRulesStat()
        .then((m) => setRulesStale(m !== reportMtime))
        .catch(() => {});
    poll();
    const id = setInterval(poll, 3000);
    window.addEventListener("focus", poll);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", poll);
    };
  }, [view, reportMtime]);

  const leaveRules = () => {
    setView("results");
    if (rulesSaved) {
      setRulesSaved(false);
      scan(folders);
    }
  };

  // ── What's on screen ──────────────────────────────────────────────

  const projects = useMemo(
    () => (report ? visibleProjects(report, filters).sort((a, b) => sum(b.items) - sum(a.items)) : []),
    [report, filters],
  );
  const worktrees = useMemo(
    () => (report ? visibleWorktrees(report, filters).sort((a, b) => b.worktree!.size - a.worktree!.size) : []),
    [report, filters],
  );
  const lists = useMemo(() => {
    const out = {} as Record<Exclude<Tab, "projects" | "worktrees">, DevItem[]>;
    for (const c of ["sdk", "caches", "ide", "ai", "old"] as const)
      out[c] = report ? visibleItems(report, filters, c).sort((a, b) => b.size - a.size) : [];
    return out;
  }, [report, filters]);

  const tabSize = (x: Tab) =>
    x === "projects" ? sum(projects.flatMap((p) => p.items)) : x === "worktrees" ? sum(worktrees.map((p) => p.worktree!)) : sum(lists[x]);

  // A filter can empty the open tab while the data it matches sits in another one; follow it.
  useEffect(() => {
    if (tabSize(tab) > 0) return;
    const best = TABS.map((x) => ({ x, size: tabSize(x) })).sort((a, b) => b.size - a.size)[0];
    if (best && best.size > 0) setTab(best.x);
    // Only when the filters change, so choosing an empty tab by hand still works.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  /** Ecosystems that have something to show under the safety and age filters, with how much; ticked ones stay listed. */
  const ecoStats = useMemo(() => {
    if (!report) return [];
    const others: Filters = { ...filters, eco: [] };
    const by = new Map<string, { count: number; size: number }>();
    const add = (i: DevItem, activeAt: number) => {
      if (!itemPasses(i, others, activeAt)) return;
      const s = by.get(i.eco) ?? { count: 0, size: 0 };
      by.set(i.eco, { count: s.count + 1, size: s.size + i.size });
    };
    report.items.forEach((i) => add(i, i.mtime));
    report.projects.forEach((p) => p.items.forEach((i) => add(i, p.lastActive)));
    for (const id of filters.eco) if (!by.has(id)) by.set(id, { count: 0, size: 0 });
    return [...by].sort((a, b) => b[1].size - a[1].size).map(([id, stats]) => ({ id, ...stats }));
  }, [report, filters]);

  /** Size of anything that can be selected, by path. */
  const sizes = useMemo(() => {
    const m = new Map<string, number>();
    if (!report) return m;
    for (const i of report.items) m.set(i.path, i.size);
    for (const p of report.projects) {
      for (const i of p.items) m.set(i.path, i.size);
      if (p.worktree) m.set(p.path, p.worktree.size);
    }
    return m;
  }, [report]);

  // Worktree status (git status / unpushed) is slow, so only check what the tab shows.
  useEffect(() => {
    if (tab !== "worktrees") return;
    let alive = true;
    const queue = worktrees.filter((p) => !(p.path in memo.statuses)).map((p) => p.path);
    const worker = async () => {
      for (let p = queue.shift(); p && alive; p = queue.shift()) {
        const s = await api.devWorktreeStatus(p).catch(() => null);
        if (alive && s) setStatuses((m) => ({ ...m, [p]: s }));
      }
    };
    for (let i = 0; i < 4; i++) worker();
    return () => {
      alive = false;
    };
  }, [tab, worktrees]);

  // ── Selection ─────────────────────────────────────────────────────

  const setPaths = (paths: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const p of paths) (on ? next.add(p) : next.delete(p));
      return next;
    });
  const toggle = (path: string) => setPaths([path], !selected.has(path));

  const picked = topLevel(selected);
  const pickedSize = picked.reduce((s, p) => s + (sizes.get(p) ?? 0), 0);

  const quickSelect = (paths: string[]) => {
    if (paths.length === 0) return toast(t("dev.nothingToSelect"));
    setPaths(paths, true);
    toast(t("dev.quickSelected", { count: paths.length, size: formatBytes(paths.reduce((s, p) => s + (sizes.get(p) ?? 0), 0)) }));
  };

  const auto = (i: DevItem) => selectable(i) && !i.custom && (!filters.eco.length || filters.eco.includes(i.eco));

  const selectStale = () => {
    if (!report) return;
    const days = Math.max(filters.age, STALE_DAYS);
    quickSelect(
      report.projects
        .filter((p) => idleDays(p.lastActive) >= days)
        .flatMap((p) => p.items)
        .filter((i) => auto(i) && i.safety !== "caution")
        .map((i) => i.path),
    );
  };

  const selectOld = () => {
    if (!report) return;
    quickSelect(report.items.filter((i) => i.category === "old" && auto(i) && i.safety !== "caution").map((i) => i.path));
  };

  const ask = (permanent: boolean) => {
    const entries: Entry[] = picked.map((p) => ({ name: baseName(p), path: p, size: sizes.get(p) ?? 0, isDir: true, items: 0 }));
    if (entries.length) setConfirm({ entries, permanent });
  };

  const doDelete = async () => {
    if (!confirm || !report) return;
    setDeleting(true);
    const res = await runDelete(confirm);
    setDeleting(false);
    setConfirm(null);
    if (!res || res.deleted.length === 0) return;
    const gone = new Set(res.deleted);
    // Deleted worktrees leave a stale entry in their main repo until it's pruned.
    const mains = [
      ...new Set(report.projects.filter((p) => gone.has(p.path) && p.worktree?.main).map((p) => p.worktree!.main!)),
    ];
    if (mains.length) api.devPruneWorktrees(mains).catch(() => {});
    setReport(withoutPaths(report, gone));
    setSelected((s) => new Set([...s].filter((p) => !gone.has(p) && ![...gone].some((g) => p.startsWith(g + "/")))));
  };

  // ── Render ────────────────────────────────────────────────────────

  const filtered = filters.eco.length > 0 || filters.age !== 0 || filters.safety.length !== 2 || filters.safety.includes("caution");
  const shownCount =
    tab === "projects" ? projects.length : tab === "worktrees" ? worktrees.length : lists[tab].length;

  const body = () => {
    if (!report)
      return scanning ? null : <div className="py-20 text-center text-sm text-muted-foreground">{t("dev.empty")}</div>;
    if (shownCount === 0)
      return (
        <div className="py-20 text-center text-sm text-muted-foreground">
          {tab === "worktrees" && !filters.safety.includes("caution")
            ? t("dev.wtHint")
            : filtered
              ? t("dev.emptyFiltered")
              : t("dev.empty")}
        </div>
      );
    if (tab === "projects")
      return projects.map((p) => <ProjectRow key={p.path} project={p} home={home} selected={selected} onSet={setPaths} />);
    if (tab === "worktrees")
      return worktrees.map((p) => (
        <WorktreeRow
          key={p.path}
          project={p}
          home={home}
          status={statuses[p.path]}
          checked={selected.has(p.path)}
          onToggle={() => toggle(p.path)}
        />
      ));
    return lists[tab].map((i) => (
      <ItemRow key={i.path} item={i} home={home} showAge checked={selected.has(i.path)} onToggle={() => toggle(i.path)} />
    ));
  };

  if (view === "rules") return <RulesView home={home} onBack={leaveRules} onSaved={() => setRulesSaved(true)} />;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button size="sm" variant="outline" onClick={onBack}>
          <ArrowLeft /> {t("common.home")}
        </Button>
        <h1 className="shrink-0 font-medium">{t("dev.title")}</h1>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {folders.map((f) => (
            <span key={f} className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs">
              {tildify(f, home) || "/"}
              <button
                className="text-muted-foreground hover:text-foreground"
                title={t("dev.removeFolder")}
                onClick={() => setFolders(folders.filter((x) => x !== f))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {folders.length === 0 && <span className="text-xs text-muted-foreground">{t("dev.noFolders")}</span>}
          <Button size="icon-xs" variant="ghost" title={t("dev.addFolder")} onClick={addFolder}>
            <Plus />
          </Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setView("rules")} title={report ? t("dev.rulesStatus", { builtin: report.rules.builtin, custom: report.rules.custom, disabled: report.rules.disabled }) : undefined}>
          <FileCog /> {t("dev.rules")}
          {report && report.warnings.length > 0 && <TriangleAlert className="text-amber-400" />}
          {hasRulesDraft() && <span className="size-1.5 rounded-full bg-primary" title={t("dev.unsaved")} />}
        </Button>
        {scanning ? (
          <Button size="sm" variant="secondary" onClick={() => api.devCancel()}>
            <Square /> {t("dev.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => scan(folders)}>
            <RefreshCw /> {t("dev.rescan")}
          </Button>
        )}
      </header>

      {rulesStale && !scanning && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-sky-500/10 px-3 py-1.5 text-xs">
          <FileCog className="size-3.5 text-sky-400" />
          <span className="flex-1">{t("dev.rulesChangedOutside")}</span>
          <Button size="xs" variant="outline" onClick={() => scan(folders)}>
            <RefreshCw /> {t("dev.rescan")}
          </Button>
        </div>
      )}

      {report && report.warnings.length > 0 && (
        <div className="shrink-0 space-y-0.5 border-b bg-amber-500/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-amber-400">
            <TriangleAlert className="size-3.5" /> {t("dev.warningsTitle")}
            <span className="flex-1" />
            <Button size="xs" variant="outline" onClick={() => setView("rules")}>
              {t("dev.editRules")}
            </Button>
          </div>
          {report.warnings.slice(0, 5).map((w, i) => (
            <div key={i} className="font-mono text-muted-foreground">
              {w.line > 0 ? t("dev.warningAt", { file: baseName(w.file), line: w.line, col: w.col }) : baseName(w.file)}: {w.message}
            </div>
          ))}
        </div>
      )}

      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate tabular-nums">
          {t("dev.reclaimable", { size: formatBytes(tabSize(tab)) })}
          {report && !scanning && (
            <span
              className={cn(idleDays(report.scannedAt) >= 1 && "text-amber-400")}
              title={`${(report.elapsedMs / 1000).toFixed(1)}s`}
            >
              {" · "}
              {t("dev.scannedAgo", { when: timeAgo(report.scannedAt) })}
            </span>
          )}
        </span>
        <span className="flex-1" />
        <FilterMenu
          label={t("dev.filterEco")}
          value={
            filters.eco.length === 0 ? (
              t("dev.allEcos")
            ) : (
              <span className="flex items-center gap-1.5">
                {filters.eco.slice(0, 3).map((id) => (
                  <span key={id} className="size-2 rounded-full" style={{ background: eco(id).color }} />
                ))}
                {filters.eco.length === 1 ? eco(filters.eco[0]).label : t("dev.nSelected", { count: filters.eco.length })}
              </span>
            )
          }
        >
          <DropdownMenuCheckboxItem checked={filters.eco.length === 0} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setFilters((f) => ({ ...f, eco: [] }))}>
            {t("dev.allEcos")}
          </DropdownMenuCheckboxItem>
          {ecoStats.map(({ id, count, size }) => (
            <DropdownMenuCheckboxItem
              key={id}
              checked={filters.eco.includes(id)}
              // Keep the menu open so several ecosystems can be ticked in one go.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setFilters((f) => ({ ...f, eco: on ? [...f.eco, id] : f.eco.filter((x) => x !== id) }))}
            >
              <span className="size-2 rounded-full" style={{ background: eco(id).color }} />
              {eco(id).label}
              <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">
                {count} · {formatBytes(size)}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterMenu>
        <FilterMenu
          label={t("dev.filterSafety")}
          value={
            filters.safety.length === SAFETIES.length
              ? t("dev.allLevels")
              : filters.safety.length
                ? SAFETIES.filter((x) => filters.safety.includes(x))
                    .map((x) => t(`dev.safety.${x}`))
                    .join(", ")
                : "–"
          }
        >
          {SAFETIES.map((x) => (
            <DropdownMenuCheckboxItem
              key={x}
              checked={filters.safety.includes(x)}
              // Keep the menu open so several levels can be ticked in one go.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setFilters((f) => ({ ...f, safety: on ? [...f.safety, x] : f.safety.filter((y) => y !== x) }))}
            >
              <span className="flex flex-col">
                {t(`dev.safety.${x}`)}
                <span className="text-xs text-muted-foreground">{t(`dev.safetyHint.${x}`)}</span>
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterMenu>
        <FilterMenu label={t("dev.filterAge")} title={t("dev.ageHint")} value={filters.age === 0 ? t("dev.age.any") : t("dev.age.days", { days: filters.age })}>
          <DropdownMenuRadioGroup value={String(filters.age)} onValueChange={(v) => setFilters((f) => ({ ...f, age: Number(v) as Age }))}>
            {AGES.map((a) => (
              <DropdownMenuRadioItem key={a} value={String(a)}>
                {a === 0 ? t("dev.age.any") : t("dev.age.days", { days: a })}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </FilterMenu>
        {filtersChanged && (
          <Button size="xs" variant="ghost" title={t("dev.resetFilters")} onClick={() => setFilters(DEFAULT_FILTERS)}>
            <X /> {t("dev.resetFilters")}
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 space-y-0.5 border-r p-2">
          {TABS.map((x) => {
            const Icon = TAB_ICON[x];
            const size = tabSize(x);
            // Only tabs with something to show under the filters; the open one stays so it never vanishes under you.
            if (report && size === 0 && tab !== x) return null;
            return (
              <button
                key={x}
                onClick={() => setTab(x)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  tab === x && "bg-accent font-medium",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{t(`dev.tabs.${x}`)}</span>
                {size > 0 && <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(size)}</span>}
              </button>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {scanning && (
            <div className="shrink-0 space-y-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="font-medium text-foreground">{t(`dev.phase.${progress?.phase ?? "locations"}`)}</span>
                {progress && (
                  <span className="tabular-nums">
                    {progress.phase === "measure"
                      ? t("dev.progressMeasure", {
                          done: formatCount(progress.measured),
                          total: formatCount(progress.total),
                          size: formatBytes(progress.bytes),
                        })
                      : t("dev.progressWalk", { dirs: formatCount(progress.dirs), found: formatCount(progress.found) })}
                  </span>
                )}
              </div>
              {progress?.phase === "measure" && progress.total > 0 && (
                <Progress value={(progress.measured / progress.total) * 100} />
              )}
              {progress?.current && <div className="truncate font-mono">{tildify(progress.current, home)}</div>}
            </div>
          )}
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2">{body()}</div>
          </ScrollArea>
        </div>
      </div>

      <footer className="flex h-12 shrink-0 items-center gap-2 border-t px-3 text-sm">
        <Button size="sm" variant="ghost" disabled={!report} onClick={selectStale} title={t("dev.selectStaleHint", { days: Math.max(filters.age, STALE_DAYS) })}>
          {t("dev.selectStale")}
        </Button>
        <Button size="sm" variant="ghost" disabled={!report} onClick={selectOld} title={t("dev.selectOldHint")}>
          {t("dev.selectOld")}
        </Button>
        <span className="flex-1" />
        {picked.length > 0 && (
          <>
            <span className="text-muted-foreground tabular-nums">
              {t("disk.selected", { count: picked.length, size: formatBytes(pickedSize) })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t("disk.clearSelection")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => ask(false)}>
              <Trash2 /> {t("disk.moveToTrash")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => ask(true)}>
              {t("disk.deletePermanently")}
            </Button>
          </>
        )}
      </footer>

      <DeleteDialog request={confirm} busy={deleting} onCancel={() => setConfirm(null)} onConfirm={doDelete} />
    </div>
  );
}

