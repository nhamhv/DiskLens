import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import type { Summary } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { CATEGORIES, SAFETY_COLORS, SAFETY_LEVELS, categoryLabel, safetyLabel } from "@/lib/safety";

/** Sizes in the current folder by safety (one stacked bar) and by category (one bar each). */
export function SummaryPanel({ summary }: { summary: Summary }) {
  const { t } = useTranslation();
  const total = summary.safety.reduce((s, x) => s + x.size, 0);
  const bySafety = new Map(summary.safety.map((x) => [x.key, x.size]));
  const biggest = summary.categories[0]?.size ?? 0;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pt-3 pb-3 text-xs">
      <section className="space-y-2">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("summary.safety")}</h3>
        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
          {SAFETY_LEVELS.map((level) => {
            const size = bySafety.get(level) ?? 0;
            return size > 0 && total > 0 ? (
              <span key={level} style={{ width: `${(size / total) * 100}%`, background: SAFETY_COLORS[level] }} />
            ) : null;
          })}
        </div>
        <ul className="space-y-1">
          {SAFETY_LEVELS.map((level) => (
            <li key={level} className="flex items-center gap-2" title={t(`safety.${level}Hint`)}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: SAFETY_COLORS[level] }} />
              <span className="flex-1 truncate">{safetyLabel(level)}</span>
              <span className="text-muted-foreground tabular-nums">{formatBytes(bySafety.get(level) ?? 0)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("summary.categories")}</h3>
        <ul className="space-y-2">
          {summary.categories.map(({ key, size }) => {
            const { icon: Icon, color } = CATEGORIES[key];
            return (
              <li key={key} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Icon className="size-3.5 shrink-0" style={{ color }} />
                  <span className="flex-1 truncate">{categoryLabel(key)}</span>
                  <span className="text-muted-foreground tabular-nums">{formatBytes(size)}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${biggest ? (size / biggest) * 100 : 0}%`, background: color }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="flex gap-1.5 text-[11px] leading-snug text-muted-foreground">
        <Info className="mt-px size-3 shrink-0" />
        {t("summary.note")}
      </p>
    </div>
  );
}
