import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3 } from "lucide-react";
import { api } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** First-run question about the anonymous launch count. Only the two buttons record an answer;
 * closing it any other way asks again next time. Never shown in builds without an Aptabase key. */
export function StatsConsent() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .telemetryStatus()
      .then((s) => setOpen(s.available && s.consent === null))
      .catch(() => {});
  }, []);

  const answer = (agreed: boolean) => {
    setOpen(false);
    api.telemetrySetConsent(agreed).catch(() => {});
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <BarChart3 />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("stats.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("stats.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel holds focus, so a stray Enter declines. */}
          <AlertDialogCancel onClick={() => answer(false)}>{t("stats.deny")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)}>{t("stats.allow")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
