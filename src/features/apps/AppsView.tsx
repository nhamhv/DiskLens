import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ArrowUpCircle, Loader2, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { AppInfo, Entry, Footprint, Speed, UpdateInfo } from "@/lib/types";
import { baseName, formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runDelete } from "@/lib/delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DeleteDialog, type DeleteRequest } from "@/components/DeleteDialog";
import { AppDetails, AppIcon, dataTotal, total } from "./AppDetails";

type Sort = "size" | "name" | "lastUsed";

const UNUSED_DAYS = 90;

// Kept across visits so returning to this screen is instant; "Refresh" re-measures.
const memo = {
  apps: null as AppInfo[] | null,
  icons: {} as Record<string, string | null>,
  footprints: {} as Record<string, Footprint>,
  updates: {} as Record<string, UpdateInfo>,
};

const SOURCE_LABEL: Record<AppInfo["source"], string | null> = { appstore: "App Store", sparkle: "Sparkle", other: null };

export function AppsView({ speed, onBack }: { speed: Speed; onBack(): void }) {
  const { t } = useTranslation();
  const [apps, setApps] = useState<AppInfo[] | null>(memo.apps);
  const [icons, setIcons] = useState(memo.icons);
  const [footprints, setFootprints] = useState(memo.footprints);
  const [updates, setUpdates] = useState(memo.updates);
  const [measuring, setMeasuring] = useState(false);
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("size");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    memo.apps = apps;
    memo.icons = icons;
    memo.footprints = footprints;
    memo.updates = updates;
  }, [apps, icons, footprints, updates]);

  const measure = useCallback(
    async (list: AppInfo[]) => {
      setMeasuring(true);
      try {
        await api.appFootprints(
          list.map((a) => a.path),
          speed,
        );
      } catch (e) {
        toast.error(String(e));
      } finally {
        setMeasuring(false);
      }
    },
    [speed],
  );

  const load = useCallback(async () => {
    try {
      const list = await api.listApps();
      setApps(list);
      setFootprints({});
      measure(list);
    } catch (e) {
      toast.error(String(e));
    }
  }, [measure]);

  useEffect(() => {
    const off = listen<Footprint>("app-footprint", (e) => setFootprints((f) => ({ ...f, [e.payload.path]: e.payload })));
    if (!memo.apps) load();
    return () => {
      off.then((fn) => fn());
    };
  }, [load]);

  // Icons: a few at a time, skipping ones already loaded.
  useEffect(() => {
    if (!apps) return;
    let alive = true;
    const queue = apps.filter((a) => !(a.path in memo.icons)).map((a) => a.path);
    const worker = async () => {
      for (let p = queue.shift(); p && alive; p = queue.shift()) {
        const src = await api.appIcon(p).catch(() => null);
        if (alive) setIcons((m) => ({ ...m, [p]: src }));
      }
    };
    for (let i = 0; i < 6; i++) worker();
    return () => {
      alive = false;
    };
  }, [apps]);

  const checkUpdates = async () => {
    if (!apps) return;
    const targets = apps.filter((a) => a.source !== "other");
    setChecking(true);
    try {
      const res = await api.checkAppUpdates(targets.map((a) => a.path));
      setUpdates(Object.fromEntries(res.map((u) => [u.path, u])));
      const n = res.filter((u) => u.available).length;
      toast(n ? t("apps.updatesAvailable", { count: n }) : t("apps.allUpToDate"), {
        description: t("apps.checkedHint", { count: targets.length }),
      });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChecking(false);
    }
  };

  const now = Date.now() / 1000;
  const isUnused = (a: AppInfo) => a.lastUsed === null || now - a.lastUsed > UNUSED_DAYS * 86400;

  const rows = useMemo(() => {
    if (!apps) return [];
    const q = query.trim().toLowerCase();
    const list = apps.filter(
      (a) => (!q || a.name.toLowerCase().includes(q) || a.bundleId?.toLowerCase().includes(q)) && (!unusedOnly || isUnused(a)),
    );
    const by: Record<Sort, (a: AppInfo, b: AppInfo) => number> = {
      size: (a, b) => total(footprints[b.path]) - total(footprints[a.path]),
      name: (a, b) => a.name.localeCompare(b.name),
      lastUsed: (a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0), // least recently used first
    };
    return [...list].sort(by[sort]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, query, sort, unusedOnly, footprints]);

  const measured = apps ? apps.filter((a) => footprints[a.path]).length : 0;
  const sum = rows.reduce((s, a) => s + total(footprints[a.path]), 0);
  const updatesAvailable = Object.values(updates).filter((u) => u.available).length;
  const current = apps?.find((a) => a.path === selected) ?? null;

  const ask = (app: AppInfo, what: "uninstall" | "data", permanent: boolean) => {
    const f = footprints[app.path];
    const data: Entry[] = (f?.data ?? []).map((d) => ({ name: baseName(d.path), path: d.path, size: d.size, isDir: d.isDir, items: 0 }));
    const bundle: Entry = { name: baseName(app.path), path: app.path, size: f?.bundle ?? 0, isDir: true, items: 0 };
    const entries = what === "uninstall" ? [bundle, ...data] : data;
    if (entries.length) setConfirm({ entries, permanent });
  };

  const doDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    const res = await runDelete(confirm);
    setDeleting(false);
    setConfirm(null);
    if (!res) return;
    const gone = new Set(res.deleted);
    setApps((list) => list?.filter((a) => !gone.has(a.path)) ?? null);
    setFootprints((m) => {
      const next = { ...m };
      for (const [k, f] of Object.entries(next)) next[k] = { ...f, data: f.data.filter((d) => !gone.has(d.path)) };
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button size="sm" variant="outline" onClick={onBack}>
          <ArrowLeft /> {t("common.home")}
        </Button>
        <h1 className="font-medium">{t("apps.title")}</h1>
        <div className="relative ml-2 w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("apps.search")} className="h-8 pl-7" />
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={checkUpdates} disabled={checking || !apps}>
          {checking ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />}
          {checking ? t("apps.checking") : t("apps.checkUpdates")}
        </Button>
        <Button size="sm" variant="ghost" onClick={load} disabled={measuring} title={t("apps.refreshHint")}>
          <RefreshCw className={cn(measuring && "animate-spin")} /> {t("apps.refresh")}
        </Button>
      </header>

      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3 text-xs text-muted-foreground tabular-nums">
        <span>
          {t("apps.count", { count: rows.length })} · {formatBytes(sum)}
          {measuring && apps && ` · ${t("apps.measuring", { done: measured, total: apps.length })}`}
          {updatesAvailable > 0 && (
            <span className="text-primary"> · {t("apps.updatesAvailable", { count: updatesAvailable })}</span>
          )}
        </span>
        <span className="flex-1" />
        <Button
          size="xs"
          variant={unusedOnly ? "default" : "outline"}
          onClick={() => setUnusedOnly((v) => !v)}
          title={t("apps.unusedHint")}
        >
          {t("apps.unused", { days: UNUSED_DAYS })}
        </Button>
        <ToggleGroup type="single" size="sm" variant="outline" value={sort} onValueChange={(v) => v && setSort(v as Sort)}>
          <ToggleGroupItem value="size" className="data-[state=on]:text-primary">
            {t("apps.sortSize")}
          </ToggleGroupItem>
          <ToggleGroupItem value="name" className="data-[state=on]:text-primary">
            {t("apps.sortName")}
          </ToggleGroupItem>
          <ToggleGroupItem value="lastUsed" className="data-[state=on]:text-primary" title={t("apps.sortLastUsedHint")}>
            {t("apps.sortLastUsed")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="min-w-0 flex-1">
          {!apps ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("apps.reading")}
            </div>
          ) : (
            <div className="p-2">
              {rows.map((a) => {
                const f = footprints[a.path];
                const u = updates[a.path];
                return (
                  <div
                    key={a.path}
                    onClick={() => setSelected(a.path)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent",
                      selected === a.path && "bg-accent",
                    )}
                  >
                    <AppIcon src={icons[a.path]} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate font-medium">{a.name}</span>
                        {a.version && <span className="shrink-0 text-xs text-muted-foreground">{a.version}</span>}
                        {u?.available && (
                          <Badge className="shrink-0 gap-1 bg-primary/20 text-primary">
                            <ArrowUpCircle className="size-3" /> {u.latest}
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {a.lastUsed ? t("apps.lastUsed", { when: timeAgo(a.lastUsed) }) : t("apps.neverOpened")}
                        {SOURCE_LABEL[a.source] && ` · ${SOURCE_LABEL[a.source]}`}
                      </div>
                    </div>
                    <div className="w-28 shrink-0 text-right tabular-nums">
                      {f ? (
                        <>
                          <div className="text-sm">{formatBytes(total(f))}</div>
                          {dataTotal(f) > 0 && (
                            <div className="text-[11px] text-muted-foreground">{t("apps.data", { size: formatBytes(dataTotal(f)) })}</div>
                          )}
                        </>
                      ) : (
                        <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  </div>
                );
              })}
              {rows.length === 0 && <div className="py-16 text-center text-sm text-muted-foreground">{t("apps.noMatch")}</div>}
            </div>
          )}
        </ScrollArea>

        {current && (
          <AppDetails
            app={current}
            icon={icons[current.path]}
            footprint={footprints[current.path]}
            update={updates[current.path]}
            onAsk={(what, permanent) => ask(current, what, permanent)}
          />
        )}
      </div>

      <DeleteDialog request={confirm} busy={deleting} onCancel={() => setConfirm(null)} onConfirm={doDelete} />
    </div>
  );
}
