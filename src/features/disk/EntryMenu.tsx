import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Eye, FolderOpen, FolderSearch, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Entry } from "@/lib/types";
import { openInKey } from "@/lib/platform";

export interface EntryActions {
  onOpen(entry: Entry): void;
  onCopy(entry: Entry): void;
  onReveal(entry: Entry): void;
  onRescan(entry: Entry): void;
  onTrash(entries: Entry[]): void;
  onDelete(entries: Entry[]): void;
  /** Quick Look (macOS); absent where there is none. */
  onPreview?(entries: Entry[]): void;
  /** True while a scan runs: browsing works, but rescans and deletes wait for it to finish. */
  locked?: boolean;
}

interface Props extends EntryActions {
  /** Entries rendered inside; each element carries `data-path` to identify its entry. */
  entries: Entry[];
  /** Checked entries; deleting a checked entry acts on the whole selection. */
  selection?: Entry[];
  children: ReactNode;
}

/** One right-click menu for a whole list/treemap, targeting the element under the cursor. */
export function EntryMenu({ entries, selection = [], children, onOpen, onCopy, onReveal, onRescan, onTrash, onDelete, onPreview, locked }: Props) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Entry | null>(null);
  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  const onContextMenu = (ev: React.MouseEvent) => {
    const path = (ev.target as HTMLElement).closest<HTMLElement>("[data-path]")?.dataset.path;
    const entry = path ? byPath.get(path) : undefined;
    if (!entry) {
      ev.preventDefault(); // no menu on empty space or the "N items" tile
      return;
    }
    setTarget(entry);
  };

  const act = (fn: (e: Entry) => void) => () => target && fn(target);
  const bulk = target && selection.length > 1 && selection.some((e) => e.path === target.path) ? selection : null;
  const targets = bulk ?? (target ? [target] : []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel className="truncate text-xs text-muted-foreground">{target?.name}</ContextMenuLabel>
        {target?.isDir && (
          <ContextMenuItem onSelect={act(onOpen)}>
            <FolderOpen /> {t("menu.open")}
          </ContextMenuItem>
        )}
        {onPreview && (
          <ContextMenuItem onSelect={() => onPreview(targets)}>
            <Eye /> {t("menu.quickLook")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={act(onCopy)}>
          <Copy /> {t("common.copyPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={act(onReveal)}>
          <FolderSearch /> {t(openInKey())}
        </ContextMenuItem>
        {target?.isDir && (
          <ContextMenuItem disabled={locked} onSelect={act(onRescan)}>
            <RefreshCw /> {t("menu.rescanFolder")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={locked} onSelect={() => onTrash(targets)}>
          <Trash2 /> {bulk ? t("menu.moveManyToTrash", { count: bulk.length }) : t("menu.moveToTrash")}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled={locked} onSelect={() => onDelete(targets)}>
          <TriangleAlert /> {bulk ? t("menu.deleteManyPermanently", { count: bulk.length }) : t("menu.deletePermanently")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
