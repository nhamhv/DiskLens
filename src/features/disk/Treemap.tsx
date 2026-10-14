import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MousePointerClick, Sparkles } from "lucide-react";
import type { Entry } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { kindLabel, kindOf, type Kind } from "@/lib/kinds";
import { SAFETY_COLORS, safetyLabel, safetyOf } from "@/lib/safety";
import { cn } from "@/lib/utils";

/** What tile colours mean: the kind of item, or how safe it is to delete. */
export type ColorMode = "kind" | "safety";

export interface ChartProps {
  entries: Entry[];
  otherCount: number;
  otherSize: number;
  colors: ColorMode;
  onOpen(entry: Entry): void;
  /** Opens the next page of smaller items; without it the "N items" tile isn't clickable. */
  onOpenRest?(): void;
}

export interface Tile {
  key: string;
  entry: Entry | null; // null = "N items" bucket of small entries
  label: string;
  size: number;
  /** Layout weight: the real size, raised to a floor so small entries stay visible. */
  weight: number;
  kind: Kind;
  color: string;
}

interface Datum {
  size: number;
  tile?: Tile;
  children?: Datum[];
}

/** Tiles per page; the rest are grouped into one "N items" tile. */
export const MAX_TILES = 40;
/** Small entries get at least this share of the area (capped so they take ≤ 30% together). */
const MIN_SHARE = 0.02;
const MAX_FLOORED_SHARE = 0.3;

/** Size of the element behind `ref`, kept up to date. */
export function useBox(ref: React.RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/**
 * The shapes to draw: the biggest entries, then one "N items" tile for the rest.
 * Real proportions would make small folders invisible slivers next to a giant one,
 * so every tile gets a minimum area; labels and the tooltip still show the real size.
 */
export function useTiles(entries: Entry[], otherCount: number, otherSize: number, colors: ColorMode) {
  const { t } = useTranslation();
  return useMemo(() => {
    const color = (e: Entry | null, kind: Kind) => (colors === "safety" && e ? SAFETY_COLORS[safetyOf(e)] : kind.color);
    const total = entries.reduce((s, e) => s + e.size, 0) + otherSize;
    const shown: Omit<Tile, "weight">[] = [];
    let restCount = otherCount;
    let restSize = otherSize;
    for (const e of entries) {
      if (shown.length < MAX_TILES && e.size > 0) {
        const kind = kindOf(e);
        shown.push({ key: e.path, entry: e, label: e.name, size: e.size, kind, color: color(e, kind) });
      } else {
        restCount++;
        restSize += e.size;
      }
    }
    if (restCount > 0) {
      const kind = kindOf(null);
      shown.push({ key: "__rest", entry: null, label: t("common.items", { count: restCount }), size: restSize, kind, color: kind.color });
    }
    const floor = (total || 1) * Math.min(MIN_SHARE, MAX_FLOORED_SHARE / Math.max(shown.length, 1));
    return { tiles: shown.map((t) => ({ ...t, weight: Math.max(t.size, floor) })), total };
  }, [entries, otherCount, otherSize, colors, t]);
}

export type Hover = { tile: Tile; x: number; y: number } | null;

export const Treemap = forwardRef<HTMLDivElement, ChartProps & React.HTMLAttributes<HTMLDivElement>>(function Treemap(
  { entries, otherCount, otherSize, colors, onOpen, onOpenRest, className, ...rest },
  forwarded,
) {
  const ref = useRef<HTMLDivElement>(null);
  useImperativeHandle(forwarded, () => ref.current!);
  const box = useBox(ref);
  const { tiles, total } = useTiles(entries, otherCount, otherSize, colors);
  const [hover, setHover] = useState<Hover>(null);

  const rects = useMemo(() => {
    if (!box.w || !box.h || tiles.length === 0) return [];
    const root = hierarchy<Datum>({ size: 0, children: tiles.map((t) => ({ size: t.weight, tile: t })) }).sum((d) =>
      d.children ? 0 : d.size,
    );
    const laid = treemap<Datum>().tile(treemapSquarify.ratio(1.3)).size([box.w, box.h]).paddingInner(6).round(true)(root);
    return laid.leaves().map((l) => ({ tile: l.data.tile!, x: l.x0, y: l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 }));
  }, [box, tiles]);

  // Drop a stale tooltip when the folder changes under the cursor.
  useEffect(() => setHover(null), [tiles]);

  return (
    <div
      ref={ref}
      className={cn("relative min-h-0 flex-1", className)}
      onMouseLeave={() => setHover(null)}
      onContextMenuCapture={() => setHover(null)}
      {...rest}
    >
      {rects.map(({ tile, x, y, w, h }) => (
        <div
          key={tile.key}
          data-path={tile.entry?.path}
          className={cn(
            "absolute overflow-hidden rounded-lg text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_1px_2px_rgb(0_0_0/0.3)] transition-[filter] duration-100 hover:brightness-115",
            (tile.entry ? tile.entry.isDir : !!onOpenRest) && "cursor-pointer",
          )}
          style={{
            left: x,
            top: y,
            width: w,
            height: h,
            background: `linear-gradient(160deg, color-mix(in oklab, ${tile.color}, white 10%), ${tile.color})`,
          }}
          onMouseMove={(ev) => setHover({ tile, x: ev.clientX, y: ev.clientY })}
          onClick={() => (tile.entry ? tile.entry.isDir && onOpen(tile.entry) : onOpenRest?.())}
        >
          <TileLabel tile={tile} w={w} h={h} />
        </div>
      ))}
      {hover && <Tooltip {...hover} total={total} canOpenRest={!!onOpenRest} />}
    </div>
  );
});

/** Picks the richest label that fits: icon + name + size, name + size, name, vertical name, or nothing. */
function TileLabel({ tile, w, h }: { tile: Tile; w: number; h: number }) {
  const { t } = useTranslation();
  const size = `${tile.entry ? "" : "≥ "}${formatBytes(tile.size)}`;
  const Icon = tile.kind.icon;
  const name = "truncate font-medium [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]";

  if (w > 90 && h > 46) {
    return (
      <div className="flex h-full flex-col gap-0.5 p-2.5">
        <span className={cn(name, "flex items-center gap-1.5 text-sm")}>
          <Icon className="size-4 shrink-0 opacity-85" />
          <span className="truncate">{tile.label}</span>
        </span>
        <span className="pl-5.5 text-xs text-white/75 tabular-nums">{size}</span>
        {tile.entry?.safety === "safe" && h > 80 && w > 120 && (
          <span className="mt-auto flex items-center gap-1 text-[11px] text-white/70">
            <Sparkles className="size-3" /> {t("treemap.safeToClean")}
          </span>
        )}
      </div>
    );
  }
  if (w > 56 && h > 34) {
    return (
      <div className="flex h-full flex-col p-1.5 leading-tight">
        <span className={cn(name, "text-xs")}>{tile.label}</span>
        <span className="text-[10px] text-white/75 tabular-nums">{size}</span>
      </div>
    );
  }
  if (w >= 30 && h >= 16) {
    return <div className={cn(name, "px-1 py-0.5 text-[10px] leading-tight")}>{tile.label}</div>;
  }
  if (w >= 14 && h >= 40) {
    return (
      <div className={cn(name, "h-full px-0.5 py-1 text-[10px] leading-none [writing-mode:vertical-rl]")}>
        {tile.label}
      </div>
    );
  }
  return null;
}

const TOOLTIP_W = 300;

export function Tooltip({ tile, x, y, total, canOpenRest }: { tile: Tile; x: number; y: number; total: number; canOpenRest: boolean }) {
  const { t } = useTranslation();
  // Flip to the other side of the cursor near the window edges.
  const left = x + 16 + TOOLTIP_W > window.innerWidth ? x - 16 - TOOLTIP_W : x + 16;
  const top = Math.min(y + 18, window.innerHeight - 130);
  const pct = total > 0 ? (tile.size / total) * 100 : 0;
  const e = tile.entry;
  const Icon = tile.kind.icon;
  const safety = safetyOf(e);
  return (
    <div
      className="pointer-events-none fixed z-50 space-y-1.5 rounded-lg border bg-popover/95 p-3 text-xs text-popover-foreground shadow-xl backdrop-blur"
      style={{ left, top, width: TOOLTIP_W }}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="grid size-6 shrink-0 place-items-center rounded-md" style={{ background: tile.color }}>
          <Icon className="size-3.5 text-white" />
        </span>
        <span className="truncate">{tile.label}</span>
      </div>
      <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
        <b className="text-foreground">{formatBytes(tile.size)}</b>
        <span>{t("treemap.ofFolder", { pct: pct < 0.1 ? "<0.1" : pct.toFixed(1) })}</span>
        {tile.weight > tile.size && <span className="text-[10px] italic">{t("treemap.enlarged")}</span>}
        {e?.isDir && !e.collapsed && <span>{t("common.items", { count: e.items })}</span>}
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="rounded px-1.5 py-px text-[10px] text-white" style={{ background: tile.kind.color }}>
          {kindLabel(tile.kind)}
        </span>
        {e?.safety && (
          <span className="flex items-center gap-1 text-[11px]">
            <span className="size-2 rounded-full" style={{ background: SAFETY_COLORS[safety] }} />
            {safetyLabel(safety)}
          </span>
        )}
      </div>
      {e?.collapsed && <div className="text-[11px] text-muted-foreground">{t("treemap.bundle")}</div>}
      <div className="font-mono text-[11px] break-all text-muted-foreground">{e ? e.path : t("treemap.grouped")}</div>
      {!e && canOpenRest && (
        <div className="flex items-center gap-1 border-t pt-1.5 text-[11px] text-muted-foreground/80">
          <MousePointerClick className="size-3" />
          {t("treemap.clickToShowRest")}
        </div>
      )}
      {e && (
        <div className="flex items-center gap-1 border-t pt-1.5 text-[11px] text-muted-foreground/80">
          <MousePointerClick className="size-3" />
          {e.isDir && `${t("treemap.clickToOpen")} · `}
          {t("treemap.rightClick")}
        </div>
      )}
    </div>
  );
}
