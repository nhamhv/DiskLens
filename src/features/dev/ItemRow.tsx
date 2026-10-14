import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, RefreshCw, Sparkles, Terminal, TriangleAlert } from "lucide-react";
import type { DevItem, Safety } from "@/lib/types";
import { api } from "@/lib/api";
import { formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { eco, selectable, tildify } from "./model";
import { showInKey } from "@/lib/platform";

const SAFETY_ICON: Record<Safety, { icon: typeof Sparkles; className: string }> = {
  safe: { icon: Sparkles, className: "text-emerald-400" },
  rebuild: { icon: RefreshCw, className: "text-sky-400" },
  caution: { icon: TriangleAlert, className: "text-amber-400" },
};

export function SafetyIcon({ safety }: { safety: Safety }) {
  const { t } = useTranslation();
  const { icon: Icon, className } = SAFETY_ICON[safety];
  return (
    <span title={`${t(`dev.safety.${safety}`)} — ${t(`dev.safetyHint.${safety}`)}`} className="shrink-0">
      <Icon className={cn("size-3.5", className)} />
    </span>
  );
}

export const EcoDot = ({ id }: { id: string }) => (
  <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: eco(id).color }} title={eco(id).label} />
);

export function RestoreChip({ cmd }: { cmd: string }) {
  const { t } = useTranslation();
  return (
    <button
      className="flex max-w-56 min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      title={t("dev.copyRestore")}
      onClick={(e) => {
        e.stopPropagation();
        api.copyPath(cmd).then(() => toast.success(t("dev.copied"), { description: cmd }));
      }}
    >
      <Terminal className="size-3 shrink-0" />
      <span className="truncate">{cmd}</span>
    </button>
  );
}

export function ItemBadges({ item }: { item: DevItem }) {
  const { t } = useTranslation();
  return (
    <>
      {item.custom && (
        <Badge variant="outline" className="shrink-0" title={t("dev.customHint")}>
          {t("dev.custom")}
        </Badge>
      )}
      {item.viewOnly && (
        <Badge variant="secondary" className="shrink-0" title={t("dev.viewOnlyHint")}>
          {t("dev.viewOnly")}
        </Badge>
      )}
      {item.running.length > 0 && (
        <Badge variant="destructive" className="shrink-0">
          {t("dev.quitFirst", { apps: item.running.join(", ") })}
        </Badge>
      )}
    </>
  );
}

interface Props {
  item: DevItem;
  home: string;
  checked: boolean;
  onToggle(): void;
  /** Path shown under the label; defaults to the full path. */
  sub?: string;
  /** Show the folder's own age (not for project items, which use the project's). */
  showAge?: boolean;
  indent?: boolean;
}

export function ItemRow({ item, home, checked, onToggle, sub, showAge, indent }: Props) {
  const { t } = useTranslation();
  const can = selectable(item);
  return (
    <div
      className={cn(
        "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
        indent && "pl-10",
        checked && "bg-primary/10 hover:bg-primary/15",
        can && "cursor-pointer",
      )}
      onClick={() => can && onToggle()}
    >
      <Checkbox checked={checked} disabled={!can} onClick={(e) => e.stopPropagation()} onCheckedChange={onToggle} />
      <SafetyIcon safety={item.safety} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {!indent && <EcoDot id={item.eco} />}
          <span className="truncate">{item.label}</span>
          <ItemBadges item={item} />
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={item.description ?? item.path}>
          {sub ?? tildify(item.path, home)}
          {item.description && <span className="font-sans"> — {item.description}</span>}
        </div>
      </div>
      {item.restore && <RestoreChip cmd={item.restore} />}
      {showAge && <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">{timeAgo(item.mtime)}</span>}
      <span className="w-20 shrink-0 text-right tabular-nums">{formatBytes(item.size)}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        className="opacity-0 group-hover:opacity-100"
        title={t(showInKey())}
        onClick={(e) => {
          e.stopPropagation();
          api.revealInFinder(item.path);
        }}
      >
        <FolderOpen />
      </Button>
    </div>
  );
}
