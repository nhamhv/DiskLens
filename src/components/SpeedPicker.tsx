import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type { Speed, ThreadCounts } from "@/lib/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const SPEEDS: Speed[] = ["min", "low", "balanced", "high", "fast"];

let counts: ThreadCounts | null = null;

/** How many threads a scan may use; see `Speed` in src-tauri/src/state.rs. */
export function SpeedPicker({ speed, onChange, className }: { speed: Speed; onChange(s: Speed): void; className?: string }) {
  const { t } = useTranslation();
  const [threads, setThreads] = useState(counts);
  useEffect(() => {
    if (counts) return;
    api
      .scanThreads()
      .then((c) => setThreads((counts = c)))
      .catch(() => {});
  }, []);
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
        <ToggleGroupItem
          key={s}
          value={s}
          title={threads ? t("speed.threads", { count: threads[s], cpus: threads.cpus }) : undefined}
          className="data-[state=on]:text-primary"
        >
          {t(`speed.${s}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
