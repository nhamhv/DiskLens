import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Check, Copy, Focus, ImageOff, Monitor, Plus, RefreshCw, Sparkles, Square, Trash2, X, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import type { Entry, Photo, PhotoProgress, PhotoReport, Speed } from "@/lib/types";
import { formatBytes, formatCount, timeAgo } from "@/lib/format";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { runDelete } from "@/lib/delete";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DeleteDialog, type DeleteRequest } from "@/components/DeleteDialog";
import { tildify } from "@/features/dev/model";

type Tab = "similar" | "blurry" | "screenshots";
const TABS: { id: Tab; icon: LucideIcon }[] = [
  { id: "similar", icon: Copy },
  { id: "blurry", icon: Focus },
  { id: "screenshots", icon: Monitor },
];
const FOLDERS_KEY = "photos.folders";
const THUMB = 160;

const defaultFolders = (home: string) => ["Pictures", "Desktop", "Downloads"].map((d) => `${home}/${d}`);

/** Thumbnails already made this session, by path. */
const thumbs = new Map<string, string | null>();

/** Loads its thumbnail only once it scrolls into view. */
function Thumb({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState(thumbs.get(path));
  useEffect(() => {
    if (thumbs.has(path) || !ref.current) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      api
        .photoThumb(path, THUMB)
        .catch(() => null)
        .then((s) => {
          thumbs.set(path, s);
          setSrc(s);
        });
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [path]);
  return (
    <div ref={ref} className="flex size-full items-center justify-center bg-muted">
      {src ? (
        <img src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : src === null ? (
        <ImageOff className="size-6 text-muted-foreground" />
      ) : null}
    </div>
  );
}

interface TileProps {
  photo: Photo;
  checked: boolean;
  keep?: boolean;
  onToggle(): void;
  onFocus(): void;
}

function Tile({ photo, checked, keep, onToggle, onFocus }: TileProps) {
  const { t } = useTranslation();
  return (
    <button
      className={cn(
        "group relative aspect-square w-36 shrink-0 overflow-hidden rounded-lg border-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "border-destructive" : "border-transparent",
      )}
      title={photo.path}
      onClick={onToggle}
      onFocus={onFocus}
      onDoubleClick={() => api.openPath(photo.path).catch(() => {})}
    >
      <Thumb path={photo.path} />
      <span
        className={cn(
          "absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-md border bg-background/80",
          checked && "border-destructive bg-destructive text-white",
        )}
      >
        {checked && <Check className="size-3.5" />}
      </span>
      {keep && (
        <span className="absolute top-1.5 right-1.5 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {t("photos.keep")}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-4 pb-1 text-[11px] text-white">
        <span className="block truncate">{photo.name}</span>
        <span className="tabular-nums opacity-80">
          {formatBytes(photo.size)}
          {photo.modified > 0 && ` · ${timeAgo(photo.modified)}`}
        </span>
      </span>
    </button>
  );
}

/** Blurry photos, screenshots and near-duplicate shots in the user's picture folders. */
export function PhotosView({ home, speed, onBack }: { home: string; speed: Speed; onBack(): void }) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<string[]>(() => JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "null") ?? []);
  const [report, setReport] = useState<PhotoReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<PhotoProgress | null>(null);
  const [tab, setTab] = useState<Tab>("similar");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const focused = useRef<string | null>(null);

  // `home` arrives asynchronously on a cold start.
  useEffect(() => {
    if (home && folders.length === 0 && !localStorage.getItem(FOLDERS_KEY)) setFolders(defaultFolders(home));
  }, [home, folders.length]);

  useEffect(() => {
    if (folders.length) localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  }, [folders]);

  useEffect(() => {
    const off = listen<PhotoProgress>("photos-progress", (e) => setProgress(e.payload));
    return () => {
      off.then((fn) => fn());
      api.photosCancel().catch(() => {});
    };
  }, []);

  // Space previews the focused photo, like Finder.
  useEffect(() => {
    if (!platform.quickLook) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || !focused.current || confirm) return;
      e.preventDefault();
      api.quickLook([focused.current]).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);

  const scan = async (dirs: string[]) => {
    if (!dirs.length) return;
    setScanning(true);
    setProgress(null);
    try {
      const res = await api.photosScan(dirs, speed);
      if (res) {
        setReport(res);
        setSelected(new Set());
        if (res.similar.length === 0) setTab(res.blurry.length ? "blurry" : "screenshots");
      }
    } catch (e) {
      toast.error(String(e));
    }
    setScanning(false);
  };

  const addFolder = async () => {
    const picked = await open({ directory: true, multiple: true });
    const list = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter((p) => !folders.includes(p));
    if (list.length) setFolders([...folders, ...list]);
  };

  const all = useMemo(() => {
    const m = new Map<string, Photo>();
    report?.similar.flat().forEach((p) => m.set(p.path, p));
    report?.blurry.forEach((p) => m.set(p.path, p));
    report?.screenshots.forEach((p) => m.set(p.path, p));
    return m;
  }, [report]);

  const listOf = (id: Tab): Photo[] => (!report ? [] : id === "similar" ? report.similar.flat() : report[id]);
  const sizeOf = (id: Tab) => listOf(id).reduce((s, p) => s + p.size, 0);
  const picked = [...selected].map((p) => all.get(p)).filter((p): p is Photo => !!p);
  const pickedSize = picked.reduce((s, p) => s + p.size, 0);

  const toggle = (path: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const selectSuggested = () => {
    if (!report) return;
    const paths = tab === "similar" ? report.similar.flatMap((g) => g.slice(1)) : listOf(tab);
    setSelected((s) => new Set([...s, ...paths.map((p) => p.path)]));
  };

  const ask = (permanent: boolean) => {
    const entries: Entry[] = picked.map((p) => ({ name: p.name, path: p.path, size: p.size, isDir: false, items: 0 }));
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
    const keep = (p: Photo) => !gone.has(p.path);
    setReport({
      ...report,
      blurry: report.blurry.filter(keep),
      screenshots: report.screenshots.filter(keep),
      similar: report.similar.map((g) => g.filter(keep)).filter((g) => g.length > 1),
    });
    setSelected((s) => new Set([...s].filter((p) => !gone.has(p))));
  };

  const tiles = (photos: Photo[], keepFirst = false) =>
    photos.map((p, i) => (
      <Tile
        key={p.path}
        photo={p}
        keep={keepFirst && i === 0}
        checked={selected.has(p.path)}
        onToggle={() => toggle(p.path)}
        onFocus={() => (focused.current = p.path)}
      />
    ));

  const body = () => {
    if (!report)
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
          <Sparkles className="size-8" />
          <p className="max-w-md">{t("photos.intro")}</p>
          {!platform.heic && <p className="max-w-md text-xs">{t("photos.noHeic")}</p>}
          {!scanning && (
            <Button onClick={() => scan(folders)} disabled={!folders.length}>
              {t("photos.scan")}
            </Button>
          )}
        </div>
      );
    const list = listOf(tab);
    if (!list.length) return <div className="p-8 text-center text-sm text-muted-foreground">{t(`photos.empty.${tab}`)}</div>;
    if (tab === "similar")
      return (
        <div className="space-y-4 p-3">
          {report.similar.map((g) => (
            <div key={g[0].path}>
              <div className="mb-1.5 text-xs text-muted-foreground">
                {t("photos.group", { count: g.length, size: formatBytes(g.slice(1).reduce((s, p) => s + p.size, 0)) })}
              </div>
              <div className="flex flex-wrap gap-2">{tiles(g, true)}</div>
            </div>
          ))}
        </div>
      );
    return <div className="flex flex-wrap gap-2 p-3">{tiles(list)}</div>;
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button size="sm" variant="outline" onClick={onBack}>
          <ArrowLeft /> {t("common.home")}
        </Button>
        <h1 className="shrink-0 font-medium">{t("photos.title")}</h1>
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
          <Button size="icon-xs" variant="ghost" title={t("dev.addFolder")} onClick={addFolder}>
            <Plus />
          </Button>
        </div>
        {scanning ? (
          <Button size="sm" variant="secondary" onClick={() => api.photosCancel()}>
            <Square /> {t("dev.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={!folders.length} onClick={() => scan(folders)}>
            <RefreshCw /> {report ? t("dev.rescan") : t("photos.scan")}
          </Button>
        )}
      </header>

      {scanning && (
        <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
          <Progress className="flex-1" value={progress && progress.total ? (progress.done / progress.total) * 100 : 0} />
          <span className="tabular-nums">
            {progress ? t("photos.progress", { done: formatCount(progress.done), total: formatCount(progress.total) }) : t("photos.finding")}
          </span>
        </div>
      )}

      {report && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-3 text-xs text-muted-foreground">
          {TABS.map(({ id, icon: Icon }) => (
            <Button key={id} size="xs" variant={tab === id ? "secondary" : "ghost"} onClick={() => setTab(id)}>
              <Icon /> {t(`photos.tab.${id}`)}
              <span className="tabular-nums opacity-70">
                {formatCount(id === "similar" ? report.similar.length : report[id].length)} · {formatBytes(sizeOf(id))}
              </span>
            </Button>
          ))}
          <span className="flex-1" />
          <span title={report.truncated ? t("photos.truncated") : undefined} className={cn(report.truncated && "text-amber-400")}>
            {t("photos.scanned", { count: report.scanned })}
          </span>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">{body()}</ScrollArea>

      {report && (
        <footer className="flex h-12 shrink-0 items-center gap-2 border-t px-3 text-sm">
          <Button size="sm" variant="outline" onClick={selectSuggested} disabled={!listOf(tab).length}>
            {t(tab === "similar" ? "photos.selectExtras" : "photos.selectAll")}
          </Button>
          {selected.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t("photos.clear")}
            </Button>
          )}
          <span className="flex-1 text-xs text-muted-foreground tabular-nums">
            {selected.size > 0 && t("photos.selected", { count: selected.size, size: formatBytes(pickedSize) })}
            {platform.quickLook && selected.size === 0 && t("photos.quickLookHint")}
          </span>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={!picked.length} onClick={() => ask(true)}>
            {t("photos.deleteForever")}
          </Button>
          <Button size="sm" variant="destructive" disabled={!picked.length} onClick={() => ask(false)}>
            <Trash2 /> {t("photos.moveToTrash")}
          </Button>
        </footer>
      )}

      <DeleteDialog request={confirm} busy={deleting} onCancel={() => setConfirm(null)} onConfirm={doDelete} />
    </div>
  );
}
