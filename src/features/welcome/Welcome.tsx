import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Trans, useTranslation } from "react-i18next";
import { Clock, Database, FolderSearch, HardDrive, Heart, House, Images, ShieldAlert, SquareTerminal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Entry, ScanMeta, Speed } from "@/lib/types";
import { formatBytes, timeAgo } from "@/lib/format";
import { isMac, platform } from "@/lib/platform";
import { runDelete } from "@/lib/delete";
import { Button } from "@/components/ui/button";
import { DeleteDialog, type DeleteRequest } from "@/components/DeleteDialog";
import { ApplicationsIcon } from "@/components/icons";
import { LanguagePicker } from "@/components/LanguagePicker";
import { SpeedPicker } from "@/components/SpeedPicker";
import { rootLabel } from "@/features/disk/rootLabel";
import { hasDonations } from "@/features/donate/links";
import { HiddenSpace } from "./HiddenSpace";
import appIcon from "../../../assets/icon.svg";

interface Props {
  home: string;
  speed: Speed;
  onSpeed(s: Speed): void;
  onOpenFolder(path: string): void;
  onOpenApps(): void;
  onOpenDev(): void;
  onOpenPhotos(): void;
  onOpenDonate(): void;
}

export function Welcome({ home, speed, onSpeed, onOpenFolder, onOpenApps, onOpenDev, onOpenPhotos, onOpenDonate }: Props) {
  const { t } = useTranslation();
  const [caches, setCaches] = useState<ScanMeta[]>([]);
  const [fda, setFda] = useState<boolean | null>(null);
  const [trash, setTrash] = useState<Entry[]>([]);
  // Snapshot taken when the button is clicked, so a Trash refresh can't change what is confirmed.
  const [trashRequest, setTrashRequest] = useState<DeleteRequest | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [focusCount, setFocusCount] = useState(0);

  const refreshCaches = useCallback(() => {
    api.listCaches().then(setCaches).catch(() => {});
  }, []);
  const cacheTotal = caches.reduce((sum, c) => sum + c.cacheBytes, 0);
  const clearCaches = () =>
    api
      .clearCaches()
      .then((freed) => toast.success(t("welcome.cachesCleared", { size: formatBytes(freed) })))
      .catch((e) => toast.error(String(e)))
      .finally(refreshCaches);

  const refreshTrash = useCallback(() => {
    api
      .trashContents()
      .then((items) => setTrash(items ?? []))
      .catch(() => {});
  }, []);
  const trashSize = trash.reduce((sum, e) => sum + e.size, 0);
  const emptyTrash = async () => {
    if (!trashRequest) return;
    setEmptying(true);
    await runDelete(trashRequest);
    setEmptying(false);
    setTrashRequest(null);
    refreshTrash();
    refreshCaches();
  };

  useEffect(() => {
    refreshCaches();
    // Re-check after the user returns from System Settings or trashes something in Finder.
    const onFocus = () => {
      api.hasFullDiskAccess().then(setFda);
      refreshTrash();
      setFocusCount((n) => n + 1);
    };
    onFocus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshCaches, refreshTrash]);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") onOpenFolder(picked);
  };

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto px-6 py-16">
      <div className="absolute top-3 right-3 flex items-center gap-1">
        {hasDonations && (
          <Button size="sm" variant="ghost" onClick={onOpenDonate}>
            <Heart className="text-rose-400" /> {t("donate.support")}
          </Button>
        )}
        <LanguagePicker />
      </div>
      <img src={appIcon} alt="" draggable={false} className="mb-4 size-36 drop-shadow-[0_0_40px_oklch(0.7_0.1_60/0.3)]" />
      <h1 className="text-3xl font-semibold tracking-tight">DiskLens</h1>
      <p className="mt-1 text-muted-foreground">{t(isMac() ? "welcome.tagline" : "welcome.taglineOther")}</p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button size="lg" onClick={() => onOpenFolder(home)} disabled={!home}>
          <House /> {t("common.home")}
        </Button>
        <Button size="lg" variant="secondary" onClick={() => onOpenFolder("/")}>
          <HardDrive /> {t("common.wholeDisk")}
        </Button>
        {platform.apps && (
          <Button size="lg" variant="secondary" onClick={onOpenApps}>
            <ApplicationsIcon /> {t("welcome.applications")}
          </Button>
        )}
        <Button size="lg" variant="secondary" onClick={onOpenDev}>
          <SquareTerminal /> {t("welcome.developer")}
        </Button>
        <Button size="lg" variant="secondary" onClick={onOpenPhotos}>
          <Images /> {t("welcome.photos")}
        </Button>
        <Button size="lg" variant="outline" onClick={chooseFolder}>
          <FolderSearch /> {t("welcome.chooseFolder")}
        </Button>
        {trash.length > 0 && (
          <Button size="lg" variant="outline" title={t("welcome.emptyTrashHint")} onClick={() => setTrashRequest({ entries: trash, permanent: true })}>
            <Trash2 /> {t("welcome.emptyTrash", { size: formatBytes(trashSize) })}
          </Button>
        )}
      </div>
      <SpeedPicker speed={speed} onChange={onSpeed} className="mt-4" />
      <p className="mt-3 text-xs text-muted-foreground">{t("welcome.dropHint")}</p>
      {platform.hiddenSpace && <HiddenSpace refreshKey={focusCount} />}

      {caches.length > 0 && (
        <div className="mt-10 w-full max-w-2xl">
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" /> {t("welcome.previousScans")}
            <span className="flex-1" />
            <Button size="xs" variant="ghost" title={t("welcome.clearCachesHint")} onClick={clearCaches}>
              {t("welcome.clearCaches", { size: formatBytes(cacheTotal) })}
            </Button>
          </div>
          <div className="overflow-hidden rounded-xl border bg-card/60">
            {caches.map((c) => (
              <div
                key={c.root}
                className="group flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 text-sm last:border-b-0 hover:bg-accent"
                onClick={() => onOpenFolder(c.root)}
              >
                <span className="font-medium">{rootLabel(c.root, home)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{c.root}</span>
                <span className="tabular-nums">{formatBytes(c.size)}</span>
                <span className="w-28 text-right text-xs text-muted-foreground">{timeAgo(c.scannedAt)}</span>
                <span
                  className="flex w-20 items-center justify-end gap-1 text-xs text-muted-foreground tabular-nums"
                  title={t("welcome.cacheSizeHint")}
                >
                  <Database className="size-3 shrink-0" /> {formatBytes(c.cacheBytes)}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title={t("welcome.forgetScan")}
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    api.forgetCache(c.root).then(refreshCaches);
                  }}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {platform.fullDiskAccess && fda === false && (
        <div className="mt-8 flex max-w-xl gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <div>
              <b>{t("welcome.fdaOff")}</b> — {t("welcome.fdaOffDetail")}{" "}
              <button className="text-primary underline-offset-2 hover:underline" onClick={() => api.openFullDiskAccessSettings()}>
                {t("welcome.openSettings")}
              </button>
            </div>
            <div className="text-xs text-muted-foreground">
              <Trans i18nKey="welcome.fdaDevHint" components={{ code: <code />, b: <b /> }} />
            </div>
          </div>
        </div>
      )}
      <DeleteDialog
        request={trashRequest}
        busy={emptying}
        onCancel={() => setTrashRequest(null)}
        onConfirm={emptyTrash}
      />
    </div>
  );
}
