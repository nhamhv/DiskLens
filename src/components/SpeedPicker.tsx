import { useTranslation } from "react-i18next";
import type { Speed } from "@/lib/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const SPEEDS: Speed[] = ["low", "balanced", "fast"];

/** How many cores a scan may use; see `Speed` in src-tauri/src/state.rs. */
export function SpeedPicker({ speed, onChange, className }: { speed: Speed; onChange(s: Speed): void; className?: string }) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={speed}
      onValueChange={(v) => v && onChange(v as Speed)}
      className={className}
    >
      {SPEEDS.map((s) => (
        <ToggleGroupItem key={s} value={s} title={t(`speed.${s}Hint`)} className="data-[state=on]:text-primary">
          {t(`speed.${s}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
