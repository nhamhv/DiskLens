import { Trans, useTranslation } from "react-i18next";
import { AppWindowMac, ArrowUpCircle, Eraser, ExternalLink, FolderSearch, Loader2, Play, Trash2, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import type { AppInfo, Footprint, UpdateInfo } from "@/lib/types";
import { formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export const total = (f?: Footprint) => (f ? f.bundle + f.data.reduce((s, d) => s + d.size, 0) : 0);
export const dataTotal = (f?: Footprint) => (f ? f.data.reduce((s, d) => s + d.size, 0) : 0);

export function AppIcon({ src, className }: { src?: string | null; className?: string }) {
  return src ? (
    <img src={src} alt="" className={cn("shrink-0", className)} draggable={false} />
  ) : (
    <div className={cn("grid shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground", className)}>
      <AppWindowMac className="size-1/2" />
    </div>
  );
}

/** Right-hand panel for one app: versions, update status, where its data lives, uninstall. */
export function AppDetails({
  app,
  icon,
  footprint: f,
  update: u,
  onAsk,
}: {
  app: AppInfo;
  icon?: string | null;
  footprint?: Footprint;
  update?: UpdateInfo;
  onAsk(what: "uninstall" | "data", permanent: boolean): void;
}) {
  const { t } = useTranslation();
  const home = app.path.match(/^\/Users\/[^/]+/)?.[0];
  const short = (p: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l bg-card/60">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-5">
          <div className="flex items-center gap-4">
            <AppIcon src={icon} className="size-16" />
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold">{app.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {app.version ?? "?"}
                {app.build && app.build !== app.version && ` (${app.build})`}
                {app.bundleId && ` · ${app.bundleId}`}
              </div>
              <div className="text-xs text-muted-foreground">
                {app.lastUsed ? t("apps.lastUsed", { when: timeAgo(app.lastUsed) }) : t("apps.neverOpened")}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => api.openPath(app.path)}>
              <Play /> {t("apps.open")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => api.revealInFinder(app.path)}>
              <FolderSearch /> {t("common.showInFinder")}
            </Button>
          </div>

          {u && (
            <div
              className={cn(
                "rounded-lg border p-3 text-sm",
                u.available ? "border-primary/40 bg-primary/10" : "text-muted-foreground",
              )}
            >
              {u.error ? (
                u.error
              ) : u.available ? (
                <div className="flex items-center gap-2">
                  <ArrowUpCircle className="size-4 text-primary" />
                  <span className="flex-1">
                    <Trans i18nKey="apps.versionAvailable" values={{ version: u.latest }} components={{ b: <b /> }} />
                  </span>
                  <Button size="xs" onClick={() => api.openPath(u.url ?? app.path)} title={u.url ? t("apps.openInAppStore") : t("apps.openToUpdateHint")}>
                    {u.url ? t("apps.appStore") : t("apps.openToUpdate")} <ExternalLink />
                  </Button>
                </div>
              ) : (
                u.latest ? t("apps.upToDateLatest", { version: u.latest }) : t("apps.upToDate")
              )}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
              <span>{t("apps.diskUsage")}</span>
              {f && <span className="text-sm font-medium text-foreground tabular-nums">{formatBytes(total(f))}</span>}
            </div>
            {!f ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {t("apps.measuringOne")}
              </div>
            ) : (
              <div className="divide-y rounded-lg border text-xs">
                <Location label={t("apps.application")} path={short(app.path)} full={app.path} size={f.bundle} />
                {f.data.map((d) => (
                  <Location key={d.path} label={d.path.split("/Library/")[1]?.split("/")[0] ?? t("apps.dataLocation")} path={short(d.path)} full={d.path} size={d.size} />
                ))}
                {f.data.length === 0 && <div className="px-3 py-2 text-muted-foreground">{t("apps.noData")}</div>}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t pt-4">
            <Button variant="destructive" className="w-full" onClick={() => onAsk("uninstall", false)} disabled={!f}>
              <Trash2 /> {t("apps.uninstall")}
            </Button>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() => onAsk("data", false)}
                disabled={!f?.data.length}
                title={t("apps.resetDataHint")}
              >
                <Eraser /> {t("apps.resetData")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 text-destructive hover:text-destructive"
                onClick={() => onAsk("uninstall", true)}
                disabled={!f}
              >
                <TriangleAlert /> {t("apps.deletePermanently")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("apps.safetyNote")}
            </p>
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}

function Location({ label, path, full, size }: { label: string; path: string; full: string; size: number }) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={full}>
          {path}
        </div>
      </div>
      <span className="shrink-0 tabular-nums">{formatBytes(size)}</span>
      <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100" title={t("common.showInFinder")} onClick={() => api.revealInFinder(full)}>
        <FolderSearch />
      </Button>
    </div>
  );
}
