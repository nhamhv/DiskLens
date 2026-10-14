import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import type { Entry } from "@/lib/types";
import { formatBytes } from "@/lib/format";

export interface DeleteRequest {
  entries: Entry[];
  permanent: boolean;
}

interface Props {
  request: DeleteRequest | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}

const PREVIEW = 5;

/** “name” for one entry, “N items” for several — shared by the dialog and the result toast. */
export const describe = (entries: Entry[]) =>
  entries.length === 1 ? i18n.t("delete.named", { name: entries[0].name }) : i18n.t("common.items", { count: entries.length });

/**
 * Move to Trash: one confirmation.
 * Delete permanently: two — a warning, then a final "are you sure" where Cancel holds focus,
 * so pressing Enter twice can never wipe anything.
 */
export function DeleteDialog({ request, busy, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2>(1);
  useEffect(() => setStep(1), [request]);

  const entries = request?.entries ?? [];
  const permanent = request?.permanent ?? false;
  const final = !permanent || step === 2;
  const size = entries.reduce((s, e) => s + e.size, 0);
  const what = describe(entries);
  const sizeText = formatBytes(size);
  const rich = { b: <b />, red: <b className="text-destructive" /> };
  const risky = entries.filter((e) => e.safety === "risky");

  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent key={step} className="sm:max-w-md">
        {entries.length > 0 && (
          <>
            <AlertDialogHeader>
              <AlertDialogMedia className={permanent ? "bg-destructive/15 text-destructive" : undefined}>
                {permanent ? <TriangleAlert /> : <Trash2 />}
              </AlertDialogMedia>
              <AlertDialogTitle className="break-all">
                {!permanent
                  ? t("delete.titleTrash", { what })
                  : step === 1
                    ? t("delete.titlePermanent", { what })
                    : t("delete.titleSure")}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="min-w-0 space-y-2">
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground/80">
                    {entries.slice(0, PREVIEW).map((e) => (
                      <li key={e.path} className="flex gap-2">
                        <span className="min-w-0 flex-1 truncate" title={e.path}>
                          {e.path}
                        </span>
                        {entries.length > 1 && <span className="shrink-0 text-muted-foreground">{formatBytes(e.size)}</span>}
                      </li>
                    ))}
                    {entries.length > PREVIEW && (
                      <li className="text-muted-foreground">{t("delete.more", { count: entries.length - PREVIEW })}</li>
                    )}
                  </ul>
                  {risky.length > 0 && step === 1 && (
                    <p className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        {t("delete.riskyWarning", {
                          count: risky.length,
                          size: formatBytes(risky.reduce((s, e) => s + e.size, 0)),
                        })}
                      </span>
                    </p>
                  )}
                  {!permanent && (
                    <p>
                      <Trans i18nKey="delete.trashNote" count={entries.length} values={{ size: sizeText }} components={rich} />
                    </p>
                  )}
                  {permanent && step === 1 && (
                    <p>
                      <Trans i18nKey="delete.permanentNote" values={{ size: sizeText }} components={rich} />
                    </p>
                  )}
                  {permanent && step === 2 && (
                    <p className="text-destructive">
                      <Trans i18nKey="delete.sureNote" values={{ size: sizeText, what }} components={rich} />
                    </p>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* The safe action takes focus so Enter never deletes by accident. */}
              <AlertDialogCancel disabled={busy} autoFocus>
                {t("common.cancel")}
              </AlertDialogCancel>
              {final ? (
                <Button variant="destructive" disabled={busy} onClick={onConfirm}>
                  {busy && <Loader2 className="animate-spin" />}
                  {busy ? t("delete.working") : permanent ? t("delete.forever") : t("delete.trash")}
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => setStep(2)}>
                  {t("delete.continue")}
                </Button>
              )}
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
