import { createElement } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { DeleteResult } from "@/lib/types";
import { describe, type DeleteRequest } from "@/components/DeleteDialog";
import i18n from "@/i18n";
import { baseName, formatBytes } from "@/lib/format";

/** Runs a confirmed delete and reports the outcome; returns null if the call itself failed. */
export async function runDelete({ entries, permanent }: DeleteRequest): Promise<DeleteResult | null> {
  const t = i18n.t;
  const what = describe(entries);
  try {
    const res = await api.deletePaths(
      entries.map((e) => e.path),
      permanent,
    );
    // Paths outside the scanned tree report 0 freed, so fall back to the sizes we showed.
    const gone = new Set(res.deleted);
    const shown = entries.filter((e) => gone.has(e.path)).reduce((s, e) => s + e.size, 0);
    const freed = Math.max(res.freed, shown);
    const done = res.deleted.length === entries.length ? what : t("delete.partial", { done: res.deleted.length, what });
    const size = formatBytes(freed);
    if (res.deleted.length > 0) {
      if (permanent) toast.success(t("delete.donePermanent", { what: done }), { description: t("delete.donePermanentHint", { size }) });
      else
        toast.success(t("delete.doneTrash", { what: done }), {
          description: t("delete.doneTrashHint", { size }),
          duration: 5000,
        });
    }
    if (res.failed.length > 0) {
      toast.error(t("delete.failed", { count: res.failed.length }), {
        description: createElement(
          "div",
          { className: "space-y-0.5 break-all" },
          res.failed.slice(0, 3).map((f) => createElement("div", { key: f.path }, `${baseName(f.path)}: ${f.error}`)),
        ),
        duration: 8000,
      });
    }
    return res;
  } catch (e) {
    toast.error(String(e), { duration: 6000 });
    return null;
  }
}
