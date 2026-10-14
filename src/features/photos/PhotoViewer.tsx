import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Photo } from "@/lib/types";
import { formatBytes, timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";

const VIEW_PX = 1800;

/** Decoded previews already made this session, by path; null when the image can't be decoded. */
const previews = new Map<string, string | null>();

interface Props {
  photos: Photo[];
  index: number;
  onIndex(i: number): void;
  onClose(): void;
}

/** Full-size preview of one photo, with arrow-key navigation through `photos`. */
export function PhotoViewer({ photos, index, onIndex, onClose }: Props) {
  const { t } = useTranslation();
  const photo = photos[index];
  const [src, setSrc] = useState<string | null | undefined>(photo ? previews.get(photo.path) : undefined);

  useEffect(() => {
    if (!photo) return;
    if (previews.has(photo.path)) {
      setSrc(previews.get(photo.path));
      return;
    }
    let live = true;
    setSrc(undefined);
    api
      .photoThumb(photo.path, VIEW_PX)
      .catch(() => null)
      .then((s) => {
        if (previews.size > 12) previews.delete(previews.keys().next().value as string);
        previews.set(photo.path, s);
        if (live) setSrc(s);
      });
    return () => {
      live = false;
    };
  }, [photo]);

  const go = (d: number) => {
    const next = index + d;
    if (next >= 0 && next < photos.length) onIndex(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!photo) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex shrink-0 items-center gap-3 px-4 py-2 text-sm text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{photo.name}</div>
          <div className="truncate text-xs text-white/60" title={photo.path}>
            {photo.path} · {formatBytes(photo.size)}
            {photo.modified > 0 && ` · ${timeAgo(photo.modified)}`}
          </div>
        </div>
        <span className="text-xs text-white/60 tabular-nums">
          {index + 1} / {photos.length}
        </span>
        <Button size="sm" variant="secondary" onClick={() => api.openPath(photo.path).catch(() => {})}>
          <ExternalLink /> {t("photos.openExternal")}
        </Button>
        <Button size="icon-sm" variant="ghost" className="text-white hover:text-white" title={t("photos.close")} onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {src ? (
          <img src={src} alt={photo.name} className="max-h-full max-w-full object-contain" draggable={false} onClick={(e) => e.stopPropagation()} />
        ) : src === null ? (
          <ImageOff className="size-10 text-white/50" />
        ) : (
          <Loader2 className="size-8 animate-spin text-white/60" />
        )}
        {index > 0 && (
          <Button
            size="icon-lg"
            variant="secondary"
            className="absolute left-4 rounded-full opacity-80 hover:opacity-100"
            title={t("photos.prev")}
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
          >
            <ChevronLeft />
          </Button>
        )}
        {index < photos.length - 1 && (
          <Button
            size="icon-lg"
            variant="secondary"
            className="absolute right-4 rounded-full opacity-80 hover:opacity-100"
            title={t("photos.next")}
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
          >
            <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  );
}
