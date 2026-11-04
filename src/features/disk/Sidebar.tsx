import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { ChartPie, ChevronRight, FileStack, Folder, GitCompareArrows, Hourglass, Loader2, Search, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import type { Entry, Summary } from "@/lib/types";
import { formatBytes, formatDelta, parentDir, timeAgo } from "@/lib/format";
import { kindOf } from "@/lib/kinds";
import { SAFETY_COLORS, safetyOf } from "@/lib/safety";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EntryMenu, type EntryActions } from "./EntryMenu";
import { SummaryPanel } from "./SummaryPanel";
import type { ColorMode } from "./Treemap";

export type Tab = "current" | "largest" | "changes" | "cleanup" | "summary";

/** Size changes smaller than this get no badge. */
const DELTA_MIN = 10_000_000;

const TABS: { id: Tab; icon: typeof Folder; label: string; title: string }[] = [
  { id: "current", icon: Folder, label: "disk.tabFolder", title: "disk.currentFolder" },
  { id: "largest", icon: FileStack, label: "disk.tabLargest", title: "disk.largestFiles" },
  { id: "changes", icon: GitCompareArrows, label: "disk.tabChanges", title: "disk.changesTitle" },
  { id: "cleanup", icon: Sparkles, label: "disk.tabCleanup", title: "disk.cleanupTitle" },
  { id: "summary", icon: ChartPie, label: "disk.tabSummary", title: "disk.summaryTitle" },
];

interface Props {
  /** Identifies what is listed (folder, or a page of its smaller items); a change clears filter and selection. */
  listKey: string;
  tab: Tab;
  onTab(tab: Tab): void;
  items: number;
  size: number;
  entries: Entry[];
  largest: Entry[];
  /** For the changes tab; null when there is no previous scan to compare with. */
  changes: Entry[] | null;
  /** Largest tab: only files untouched for a year. */
  oldOnly: boolean;
  onOldOnly(on: boolean): void;
  /** For the cleanup and summary tabs; null while it loads. */
  summary: Summary | null;
  colors: ColorMode;
  actions: EntryActions;
}

const NO_ENTRIES: Entry[] = [];

/** Donut of the biggest children, drawn with a conic gradient in each entry's kind or safety colour. */
function Donut({ entries, size, items, colors }: { entries: Entry[]; size: number; items: number; colors: ColorMode }) {
  const { t } = useTranslation();
  let acc = 0;
  const stops = entries.slice(0, 10).map((e) => {
    const from = (acc / size) * 360;
    acc += e.size;
    const color = colors === "safety" ? SAFETY_COLORS[safetyOf(e)] : kindOf(e).color;
    return `${color} ${from}deg ${(acc / size) * 360}deg`;
  });
  const rest = "oklch(0.35 0.02 50)";
  const bg = size > 0 ? `conic-gradient(${[...stops, `${rest} ${(acc / size) * 360}deg 360deg`].join(", ")})` : rest;
  return (
    <div className="relative size-36 rounded-full shadow-lg" style={{ background: bg }}>
      <div className="absolute inset-5 grid place-content-center rounded-full bg-card text-center shadow-inner">
        <div className="text-lg font-semibold tabular-nums">{formatBytes(size)}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums">{t("common.items", { count: items })}</div>
      </div>
    </div>
  );
}

/** Memoised: during a scan the parent re-renders on every progress tick, but only `size` changes. */
export const Sidebar = memo(function Sidebar({ listKey, tab, onTab, items, size, entries, largest, changes, oldOnly, onOldOnly, summary, colors, actions }: Props) {
  const { t } = useTranslation();
  const source =
    tab === "current"
      ? entries
      : tab === "largest"
        ? largest
        : tab === "changes"
          ? (changes ?? NO_ENTRIES)
          : tab === "cleanup"
            ? (summary?.cleanup ?? NO_ENTRIES)
            : NO_ENTRIES;
  const loading = (tab === "cleanup" || tab === "summary") && !summary;
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? source.filter((e) => e.name.toLowerCase().includes(q)) : source;
  }, [source, query]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null); // last clicked row, for shift-click ranges
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(""), [listKey]);
  // A new folder, tab, filter or reloaded list (e.g. after deleting) starts with nothing checked.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    scroller.current?.scrollTo({ top: 0 });
  }, [rows]);

  // Only the rows in view are rendered, so folders with thousands of items stay fast.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 50,
    overscan: 12,
    getItemKey: (i) => rows[i].path,
  });

  // Items gone since the previous scan can't be deleted or opened.
  const live = useMemo(() => rows.filter((e) => !e.removed), [rows]);
  const selection = useMemo(() => rows.filter((e) => selected.has(e.path)), [rows, selected]);
  const selectedSize = selection.reduce((s, e) => s + e.size, 0);
  const allChecked = live.length > 0 && selection.length === live.length;

  // Space previews the checked items, or the one under the pointer (macOS Quick Look).
  const hovered = useRef<Entry | null>(null);
  const preview = actions.onPreview;
  useEffect(() => {
    if (!preview) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== " " || ev.target instanceof HTMLInputElement || document.querySelector("[role=alertdialog]")) return;
      const targets = selection.length ? selection : hovered.current ? [hovered.current] : [];
      if (!targets.length) return;
      ev.preventDefault();
      preview(targets);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, selection]);

  const toggle = (index: number, shift: boolean) => {
    if (rows[index].removed) return;
    const on = !selected.has(rows[index].path);
    const ranged = shift && anchor.current !== null;
    const from = ranged ? Math.min(anchor.current!, index) : index;
    const to = ranged ? Math.max(anchor.current!, index) : index;
    const next = new Set(selected);
    for (let i = from; i <= to; i++) {
      if (on && !rows[i].removed) next.add(rows[i].path);
      else next.delete(rows[i].path);
    }
    setSelected(next);
    anchor.current = index;
  };

  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(live.map((e) => e.path)));

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-card/60 backdrop-blur">
      <div className="flex justify-center px-4 pt-6 pb-4">
        <Donut entries={entries} size={size} items={items} colors={colors} />
      </div>

      <Tabs value={tab} onValueChange={(v) => onTab(v as Tab)} className="px-2">
        <TabsList className="h-10 w-full">
          {TABS.map(({ id, icon: Icon, label, title }) => (
            // Five labels don't fit side by side: inactive tabs show only their icon, the active one names itself.
            <TabsTrigger
              key={id}
              value={id}
              title={t(title)}
              aria-label={t(title)}
              className="group/tab min-w-0 gap-1.5 px-1.5 text-sm data-[state=active]:flex-[4]"
            >
              <Icon className="size-4" />
              <span className="hidden truncate group-data-[state=active]/tab:inline">{t(label)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("summary.measuring")}
        </div>
      ) : tab === "summary" ? (
        <SummaryPanel summary={summary!} />
      ) : (
        <>
      {tab === "cleanup" && (
        <p className="mx-3 mt-2 text-[11px] leading-snug text-muted-foreground">
          {t("disk.cleanupHint", { count: summary!.cleanupCount, size: formatBytes(summary!.cleanupSize) })}
        </p>
      )}

      {tab === "largest" && (
        <div className="mx-3 mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Button size="xs" variant={oldOnly ? "secondary" : "ghost"} onClick={() => onOldOnly(!oldOnly)} title={t("disk.oldOnlyHint")}>
            <Hourglass /> {t("disk.oldOnly")}
          </Button>
        </div>
      )}
      {tab === "changes" && (
        <p className="mx-3 mt-2 text-[11px] leading-snug text-muted-foreground">
          {changes ? t("disk.changesHint") : t("disk.noPreviousScan")}
        </p>
      )}

      {source.length > 0 && (
        <div className="relative mx-3 mt-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            onKeyDown={(ev) => ev.key === "Escape" && setQuery("")}
            placeholder={t("disk.filterPlaceholder", { count: source.length })}
            className="h-7 pl-8 text-xs md:text-xs"
          />
        </div>
      )}

      <div className="mx-2 mt-2 flex h-8 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
        <Checkbox
          checked={allChecked ? true : selection.length > 0 ? "indeterminate" : false}
          onCheckedChange={toggleAll}
          disabled={live.length === 0}
          aria-label={t("disk.selectAll")}
        />
        {selection.length === 0 ? (
          <span className="truncate">{t("disk.selectHint")}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-foreground tabular-nums">
              {t("disk.selected", { count: selection.length, size: formatBytes(selectedSize) })}
            </span>
            <Button size="icon-xs" variant="ghost" title={t("disk.moveToTrash")} disabled={actions.locked} onClick={() => actions.onTrash(selection)}>
              <Trash2 />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              title={t("disk.deletePermanently")}
              disabled={actions.locked}
              onClick={() => actions.onDelete(selection)}
            >
              <TriangleAlert />
            </Button>
            <Button size="icon-xs" variant="ghost" title={t("disk.clearSelection")} onClick={() => setSelected(new Set())}>
              <X />
            </Button>
          </>
        )}
      </div>

      <EntryMenu entries={live} selection={selection} {...actions}>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map(({ index: i, start }) => {
              const e = rows[i];
              const kind = kindOf(e);
              const Icon = kind.icon;
              const checked = selected.has(e.path);
              return (
                <div
                  key={e.path}
                  data-index={i}
                  ref={virtual.measureElement}
                  className="absolute inset-x-0 top-0 pb-0.5"
                  style={{ transform: `translateY(${start}px)` }}
                >
                  <div
                    data-path={e.path}
                    className={cn(
                      "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent",
                      checked && "bg-primary/10 hover:bg-primary/15",
                      e.removed && "cursor-default opacity-60",
                    )}
                    onMouseEnter={() => (hovered.current = e.removed ? null : e)}
                    onMouseLeave={() => hovered.current === e && (hovered.current = null)}
                    // Folders open on click; files have nothing to open, so a click checks them.
                    onClick={(ev) => (e.removed ? undefined : e.isDir ? actions.onOpen(e) : toggle(i, ev.shiftKey))}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={e.removed}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        toggle(i, ev.shiftKey);
                      }}
                      className={cn(!checked && selection.length === 0 && "opacity-0 group-hover:opacity-100")}
                      aria-label={t("disk.selectItem", { name: e.name })}
                    />
                    <span className="grid size-7 shrink-0 place-items-center rounded-md" style={{ background: kind.color }}>
                      <Icon className="size-4 text-white" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 text-sm">
                        <span className={cn("truncate", e.removed && "line-through")}>{e.name}</span>
                        {e.safety === "safe" && <Sparkles className="size-3 shrink-0 text-emerald-300/80" />}
                        {e.delta != null && Math.abs(e.delta) >= DELTA_MIN && (
                          <span
                            className={cn(
                              "ml-auto shrink-0 rounded px-1 text-[10px] tabular-nums",
                              e.delta > 0 ? "bg-amber-500/15 text-amber-500" : "bg-emerald-500/15 text-emerald-500",
                            )}
                            title={t("disk.deltaHint")}
                          >
                            {formatDelta(e.delta)}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground tabular-nums" title={e.path}>
                        {e.removed ? t("disk.removed") : formatBytes(e.size)}
                        {tab === "largest" && e.modified && <span> · {timeAgo(e.modified)}</span>}
                        {tab !== "current" && <span> · {parentDir(e.path)}</span>}
                      </div>
                    </div>
                    {e.isDir && (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {rows.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {query
                ? t("disk.noMatches")
                : tab === "cleanup"
                  ? t("disk.nothingToClean")
                  : tab === "changes"
                    ? changes && t("disk.noChanges")
                    : tab === "largest" && oldOnly
                      ? t("disk.noOldFiles")
                      : t("disk.nothingHere")}
            </div>
          )}
        </div>
      </EntryMenu>
        </>
      )}

      <div className="flex items-center gap-1 truncate border-t px-3 py-2 text-[11px] whitespace-nowrap text-muted-foreground">
        {t("disk.footerActions")} · <kbd className="rounded border px-1">⌫</kbd> {t("disk.footerUp")} ·
        <Sparkles className="size-3 shrink-0 text-emerald-300/80" /> {t("disk.footerSafe")}
      </div>
    </aside>
  );
});
