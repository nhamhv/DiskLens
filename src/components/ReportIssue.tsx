import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bug, Check, Copy, ExternalLink, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CrashLog, IssueReport, TelemetryStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const fail = (e: unknown) => toast.error(String(e));

/** "Report a problem": shows the text that goes into a prefilled GitHub issue; the user sends it. */
export function ReportIssue() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<IssueReport | null>(null);
  const [logs, setLogs] = useState<CrashLog[]>([]);
  const [stats, setStats] = useState<TelemetryStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    Promise.all([api.issueReport(), api.listCrashLogs(), api.telemetryStatus()])
      .then(([r, l, s]) => {
        setReport(r);
        setLogs(l);
        setStats(s);
      })
      .catch(fail);
  }, [open]);

  const copy = () =>
    report &&
    api
      .copyPath(report.body)
      .then(() => setCopied(true))
      .catch(fail);

  const setConsent = (agreed: boolean) =>
    api
      .telemetrySetConsent(agreed)
      .then(() => setStats((s) => s && { ...s, consent: agreed }))
      .catch(fail);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Bug /> {t("report.button")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:w-[36rem] data-[size=default]:sm:max-w-[95vw]">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Bug />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("report.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("report.description")}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t("report.preview")}</div>
            <pre className="max-h-52 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{report?.body}</pre>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">{logs.length > 0 ? t("report.crashCount", { count: logs.length }) : t("report.noCrashes")}</span>
            <Button size="xs" variant="ghost" onClick={() => api.openCrashFolder().catch(fail)}>
              <FolderOpen /> {t("report.openFolder")}
            </Button>
          </div>
          {logs.length > 0 && <p className="text-xs text-muted-foreground">{t("report.attachHint")}</p>}
          {stats?.available && stats.consent !== null && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={stats.consent} onCheckedChange={(v) => setConsent(v === true)} />
              {t("stats.toggle")}
            </label>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.dismiss")}</AlertDialogCancel>
          <Button variant="outline" onClick={copy} disabled={!report}>
            {copied ? <Check /> : <Copy />} {copied ? t("report.copied") : t("report.copy")}
          </Button>
          <Button onClick={() => report && api.openIssue(report.url).catch(fail)} disabled={!report}>
            <ExternalLink /> {t("report.openIssue")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
