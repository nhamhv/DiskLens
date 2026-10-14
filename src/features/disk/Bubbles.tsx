import { hierarchy, pack } from "d3-hierarchy";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tooltip, useBox, useTiles, type ChartProps, type Hover, type Tile } from "./Treemap";

interface Datum {
  size: number;
  tile?: Tile;
  children?: Datum[];
}

/** The same tiles as the treemap, packed as circles. Area is proportional to size (with the same floor). */
export const Bubbles = forwardRef<HTMLDivElement, ChartProps & React.HTMLAttributes<HTMLDivElement>>(function Bubbles(
  { entries, otherCount, otherSize, colors, onOpen, onOpenRest, className, ...rest },
  forwarded,
) {
  const ref = useRef<HTMLDivElement>(null);
  useImperativeHandle(forwarded, () => ref.current!);
  const box = useBox(ref);
  const { tiles, total } = useTiles(entries, otherCount, otherSize, colors);
  const [hover, setHover] = useState<Hover>(null);

  const circles = useMemo(() => {
    if (!box.w || !box.h || tiles.length === 0) return [];
    const root = hierarchy<Datum>({ size: 0, children: tiles.map((t) => ({ size: t.weight, tile: t })) }).sum((d) =>
      d.children ? 0 : d.size,
    );
    // Pack into a square, then centre it in the box.
    const side = Math.min(box.w, box.h);
    const laid = pack<Datum>().size([side, side]).padding(5)(root);
    const dx = (box.w - side) / 2;
    const dy = (box.h - side) / 2;
    return laid.leaves().map((l) => ({ tile: l.data.tile!, x: l.x + dx, y: l.y + dy, r: l.r }));
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
      {circles.map(({ tile, x, y, r }) => (
        <div
          key={tile.key}
          data-path={tile.entry?.path}
          className={cn(
            "absolute grid place-content-center overflow-hidden rounded-full text-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.15),0_2px_6px_rgb(0_0_0/0.35)] transition-[filter] duration-100 hover:brightness-115",
            (tile.entry ? tile.entry.isDir : !!onOpenRest) && "cursor-pointer",
          )}
          style={{
            left: x - r,
            top: y - r,
            width: r * 2,
            height: r * 2,
            background: `radial-gradient(circle at 35% 28%, color-mix(in oklab, ${tile.color}, white 22%), ${tile.color} 70%)`,
          }}
          onMouseMove={(ev) => setHover({ tile, x: ev.clientX, y: ev.clientY })}
          onClick={() => (tile.entry ? tile.entry.isDir && onOpen(tile.entry) : onOpenRest?.())}
        >
          <BubbleLabel tile={tile} r={r} />
        </div>
      ))}
      {hover && <Tooltip {...hover} total={total} canOpenRest={!!onOpenRest} />}
    </div>
  );
});

function BubbleLabel({ tile, r }: { tile: Tile; r: number }) {
  if (r < 18) return null;
  const name = "truncate font-medium [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]";
  // The widest text line that fits inside the circle, a little above its centre.
  const width = r * 1.6;
  if (r < 34) {
    return (
      <span className={cn(name, "px-1 text-[10px] leading-tight")} style={{ maxWidth: width }}>
        {tile.label}
      </span>
    );
  }
  return (
    <div className="flex flex-col items-center gap-0.5 leading-tight" style={{ maxWidth: width }}>
      <span className={cn(name, "max-w-full", r > 60 ? "text-sm" : "text-xs")}>{tile.label}</span>
      <span className="text-[11px] text-white/75 tabular-nums">
        {tile.entry ? "" : "≥ "}
        {formatBytes(tile.size)}
      </span>
    </div>
  );
}
