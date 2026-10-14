import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { HiddenSpace as Hidden } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Below this, purgeable space isn't worth a mention. */
const MIN_PURGEABLE = 1e9;

/**
 * Space a folder scan can't see (macOS): purgeable space and Time Machine local snapshots,
 * with a confirmed action to delete the snapshots. `refreshKey` changes when the window regains focus.
 */
export function HiddenSpace({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<Hidden | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.hiddenSpace().then(setInfo).catch(() => {});
  }, [refreshKey]);

  if (!info || (info.purgeable < MIN_PURGEABLE && info.snapshots.length === 0)) return null;

  const thin = async () => {
    setBusy(true);
    try {
      const left = await api.thinSnapshots();
      if (left === 0) toast.success(t("hidden.thinned"));
      else toast.warning(t("hidden.someLeft", { count: left }), { description: t("hidden.someLeftHint") });
    } catch (e) {
      toast.error(t("hidden.thinFailed"), { description: String(e) });
    }
    setBusy(false);
    setConfirming(false);
    api.hiddenSpace().then(setInfo).catch(() => {});
  };

  return (
    <div className="mt-6 flex w-full max-w-2xl items-center gap-3 rounded-xl border bg-card/60 px-4 py-2.5 text-sm">
      <EyeOff className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("hidden.title")}</div>
        <div className="text-xs text-muted-foreground">
          {info.purgeable >= MIN_PURGEABLE && <span title={t("hidden.purgeableHint")}>{t("hidden.purgeable", { size: formatBytes(info.purgeable) })}</span>}
          {info.purgeable >= MIN_PURGEABLE && info.snapshots.length > 0 && " · "}
          {info.snapshots.length > 0 && t("hidden.snapshots", { count: info.snapshots.length })}
        </div>
      </div>
      {info.snapshots.length > 0 && (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          <History /> {t("hidden.thin")}
        </Button>
      )}
      <AlertDialog open={confirming} onOpenChange={(open) => !open && !busy && setConfirming(false)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogMedia>
              <History />
            </AlertDialogMedia>
            <AlertDialogTitle>{t("hidden.confirmTitle", { count: info.snapshots.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t("hidden.confirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} autoFocus>
              {t("common.cancel")}
            </AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={thin}>
              {busy && <Loader2 className="animate-spin" />} {t("hidden.thin")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
