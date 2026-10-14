import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, GitBranch, Loader2, TriangleAlert } from "lucide-react";
import type { DevProject, WorktreeStatus } from "@/lib/types";
import { api } from "@/lib/api";
import { formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EcoDot, ItemRow } from "./ItemRow";
import { selectable, sum, tildify } from "./model";
import { showInKey } from "@/lib/platform";

const RevealButton = ({ path }: { path: string }) => {
  const { t } = useTranslation();
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="opacity-0 group-hover:opacity-100"
      title={t(showInKey())}
      onClick={(e) => {
        e.stopPropagation();
        api.revealInFinder(path);
      }}
    >
      <FolderOpen />
    </Button>
  );
};

interface ProjectProps {
  project: DevProject;
  home: string;
  selected: Set<string>;
  onSet(paths: string[], on: boolean): void;
}

export function ProjectRow({ project: p, home, selected, onSet }: ProjectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const can = p.items.filter(selectable).map((i) => i.path);
  const on = can.filter((x) => selected.has(x)).length;
  const state = on === 0 ? false : on === can.length ? true : "indeterminate";
  const ecos = [...new Set(p.items.map((i) => i.eco))];
  return (
    <div>
      <div
        className={cn("group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-accent", on > 0 && "bg-primary/5")}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Checkbox
          checked={state}
          disabled={can.length === 0}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={() => onSet(can, state !== true)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="truncate font-medium">{p.name}</span>
            {ecos.map((e) => (
              <EcoDot key={e} id={e} />
            ))}
            {p.worktree && (
              <Badge variant="outline" className="shrink-0 gap-1">
                <GitBranch /> {t(`dev.worktree.${p.worktree.kind}`)}
              </Badge>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{tildify(p.path, home)}</div>
        </div>
        <span className="w-32 shrink-0 text-right text-xs text-muted-foreground" title={t("dev.lastActive")}>
          {timeAgo(p.lastActive)}
        </span>
        <span className="w-20 shrink-0 text-right text-sm tabular-nums">{formatBytes(sum(p.items))}</span>
        <RevealButton path={p.path} />
      </div>
      {open &&
        p.items.map((i) => (
          <ItemRow
            key={i.path}
            item={i}
            home={home}
            indent
            sub={i.path.slice(p.path.length + 1)}
            checked={selected.has(i.path)}
            onToggle={() => onSet([i.path], !selected.has(i.path))}
          />
        ))}
    </div>
  );
}

interface WorktreeProps {
  project: DevProject;
  home: string;
  status: WorktreeStatus | undefined;
  checked: boolean;
  onToggle(): void;
}

export function WorktreeRow({ project: p, home, status, checked, onToggle }: WorktreeProps) {
  const { t } = useTranslation();
  const wt = p.worktree!;
  const risky = status && (status.dirty > 0 || (status.unpushed ?? 0) > 0);
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-accent",
        checked && "bg-primary/10 hover:bg-primary/15",
      )}
      onClick={onToggle}
    >
      <Checkbox checked={checked} onClick={(e) => e.stopPropagation()} onCheckedChange={onToggle} />
      <GitBranch className="size-3.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate font-medium">{p.name}</span>
          <Badge variant="outline" className="shrink-0">
            {t(`dev.worktree.${wt.kind}`)}
          </Badge>
          {!status ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> {t("dev.wtChecking")}
            </span>
          ) : (
            <>
              <span className="truncate font-mono text-xs text-muted-foreground">{status.branch ?? t("dev.wtDetached")}</span>
              {risky ? (
                <>
                  {status.dirty > 0 && (
                    <Badge variant="destructive" className="shrink-0 gap-1">
                      <TriangleAlert /> {t("dev.wtDirty", { count: status.dirty })}
                    </Badge>
                  )}
                  {(status.unpushed ?? 0) > 0 && (
                    <Badge variant="destructive" className="shrink-0 gap-1">
                      <TriangleAlert /> {t("dev.wtUnpushed", { count: status.unpushed })}
                    </Badge>
                  )}
                </>
              ) : (
                <Badge variant="secondary" className="shrink-0">
                  {t("dev.wtClean")}
                </Badge>
              )}
            </>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {tildify(p.path, home)}
          {wt.main && <span className="font-sans"> — {t("dev.mainRepo", { path: tildify(wt.main, home) })}</span>}
        </div>
      </div>
      <span className="w-32 shrink-0 text-right text-xs text-muted-foreground" title={t("dev.lastActive")}>
        {timeAgo(p.lastActive)}
      </span>
      <span className="w-20 shrink-0 text-right text-sm tabular-nums">{formatBytes(wt.size)}</span>
      <RevealButton path={p.path} />
    </div>
  );
}
