import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Loader2, Trash2, TriangleAlert } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import i18n from "@/i18n";
import type { Entry } from "@/lib/types";
import { formatBytes } from "@/lib/format";

export interface DeleteRequest {
  entries: Entry[];
  permanent: boolean;
  /** Skip the first warning and open straight on the final "are you sure" step (e.g. Empty Trash). */
  skipWarning?: boolean;
}

interface Props {
  request: DeleteRequest | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}

const PREVIEW = 5;

/** "Don't ask again" for Move to Trash lasts an hour; permanent deletes always ask. */
const SKIP_KEY = "disklens.skipTrashConfirmUntil";
const SKIP_MS = 60 * 60 * 1000;
const skipTrashConfirm = () => {
  try {
    return Number(localStorage.getItem(SKIP_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
};
const rememberSkip = () => {
  try {
    localStorage.setItem(SKIP_KEY, String(Date.now() + SKIP_MS));
  } catch {
    /* storage unavailable: keep asking */
  }
};

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
  const [expanded, setExpanded] = useState(false);
  const [skipNext, setSkipNext] = useState(false);
  const [sort, setSort] = useState<{ key: "name" | "size"; desc: boolean } | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // Reset per request while rendering (not in an effect) so a skipped warning never flashes.
  const [seen, setSeen] = useState(request);
  if (seen !== request) {
    setSeen(request);
    setStep(request?.permanent && request.skipWarning ? 2 : 1);
    setExpanded(false);
    setSkipNext(false);
    setSort(null);
    setPos({ x: 0, y: 0 });
  }

  // Within the "don't ask again" hour, a Trash move goes straight through without showing the dialog.
  const silent = !!request && !request.permanent && skipTrashConfirm();
  useEffect(() => {
    if (silent && !busy) onConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const confirm = () => {
    if (!permanent && skipNext) rememberSkip();
    onConfirm();
  };

  /** Drag the dialog by its title. */
  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const ox = e.clientX - pos.x;
    const oy = e.clientY - pos.y;
    const move = (ev: PointerEvent) => setPos({ x: ev.clientX - ox, y: ev.clientY - oy });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const entries = request?.entries ?? [];
  const permanent = request?.permanent ?? false;
  const final = !permanent || step === 2;
  const size = entries.reduce((s, e) => s + e.size, 0);
  const what = describe(entries);
  const sizeText = formatBytes(size);
  const rich = { b: <b />, red: <b className="text-destructive" /> };
  const sorted = useMemo(() => {
    if (!sort) return entries;
    const dir = sort.desc ? -1 : 1;
    return [...entries].sort((a, b) => dir * (sort.key === "size" ? a.size - b.size : a.name.localeCompare(b.name, undefined, { numeric: true })));
  }, [entries, sort]);
  // Size sorts biggest-first on the first click, name sorts A–Z.
  const toggleSort = (key: "name" | "size") =>
    setSort((s) => (s?.key === key ? { key, desc: !s.desc } : { key, desc: key === "size" }));
  const risky = entries.filter((e) => e.safety === "risky");

  return (
    <AlertDialog open={!!request && !silent} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent
        key={step}
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
        className="max-h-[90vh] min-h-56 min-w-80 resize grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden sm:w-[40rem] data-[size=default]:sm:max-w-[95vw]"
      >
        {entries.length > 0 && (
          <>
            <AlertDialogHeader className="min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]! sm:grid-cols-[auto_minmax(0,1fr)] sm:grid-rows-[auto_minmax(0,1fr)]!">
              <AlertDialogMedia className={permanent ? "bg-destructive/15 text-destructive" : undefined}>
                {permanent ? <TriangleAlert /> : <Trash2 />}
              </AlertDialogMedia>
              <AlertDialogTitle className="cursor-move touch-none break-all select-none" onPointerDown={startDrag}>
                {!permanent
                  ? t("delete.titleTrash", { what })
                  : step === 1
                    ? t("delete.titlePermanent", { what })
                    : t("delete.titleSure")}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="flex min-h-0 w-full min-w-0 flex-col gap-2 self-stretch">
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md bg-muted">
                  {entries.length > 1 && (
                      <div className="flex shrink-0 gap-2 border-b border-foreground/10 px-2 py-1 pr-4 text-xs text-muted-foreground">
                        {(["name", "size"] as const).map((key) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleSort(key)}
                            className={`flex items-center gap-1 hover:text-foreground ${key === "name" ? "min-w-0 flex-1" : "w-20 shrink-0 justify-end"} ${sort?.key === key ? "text-foreground" : ""}`}
                          >
                            {t(key === "name" ? "delete.sortName" : "delete.sortSize")}
                            {sort?.key === key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                          </button>
                        ))}
                      </div>
                    )}
                  <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1 font-mono text-xs text-foreground/80">
                    {(expanded ? sorted : sorted.slice(0, PREVIEW)).map((e) => (
                      <li key={e.path} className="flex gap-2">
                        {/* Truncate the parent folder, never the file name, so long common prefixes stay readable. */}
                        <span className="flex min-w-0 flex-1" title={e.path}>
                          <span className="min-w-0 truncate text-muted-foreground">{e.path.slice(0, e.path.length - e.name.length)}</span>
                          <span className="min-w-0 shrink-0 max-w-full truncate">{e.name}</span>
                        </span>
                        {entries.length > 1 && <span className="w-20 shrink-0 text-right text-muted-foreground">{formatBytes(e.size)}</span>}
                      </li>
                    ))}
                    {entries.length > PREVIEW && (
                      <li>
                        <button
                          type="button"
                          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          onClick={() => setExpanded((v) => !v)}
                        >
                          {expanded ? t("delete.showLess") : t("delete.more", { count: entries.length - PREVIEW })}
                        </button>
                      </li>
                    )}
                  </ul>
                  </div>
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
                    <p className="shrink-0">
                      <Trans i18nKey="delete.trashNote" count={entries.length} values={{ size: sizeText }} components={rich} />
                    </p>
                  )}
                  {!permanent && (
                    <label className="flex w-fit shrink-0 cursor-pointer items-center gap-2 text-foreground/80">
                      <Checkbox checked={skipNext} onCheckedChange={(v) => setSkipNext(v === true)} />
                      {t("delete.skipHour")}
                    </label>
                  )}
                  {permanent && step === 1 && (
                    <p className="shrink-0">
                      <Trans i18nKey="delete.permanentNote" values={{ size: sizeText }} components={rich} />
                    </p>
                  )}
                  {permanent && step === 2 && (
                    <p className="shrink-0 text-destructive">
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
                <Button variant="destructive" disabled={busy} onClick={confirm}>
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
