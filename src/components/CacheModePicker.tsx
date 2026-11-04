import { useTranslation } from "react-i18next";
import type { CacheMode } from "@/lib/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const MODES: CacheMode[] = ["auto", "disk", "memory"];

/** Where saved scans live; see `CacheMode` in src-tauri/src/cache.rs. */
export function CacheModePicker({ mode, onChange, className }: { mode: CacheMode; onChange(m: CacheMode): void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-2 text-xs text-muted-foreground ${className ?? ""}`}>
      {t("cacheMode.label")}
      <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && onChange(v as CacheMode)}>
        {MODES.map((m) => (
          <ToggleGroupItem key={m} value={m} title={t(`cacheMode.${m}Hint`)} className="data-[state=on]:text-primary">
            {t(`cacheMode.${m}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
