import i18n from "@/i18n";

/** Decimal units, matching Finder. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1000;
    i++;
  } while (v >= 1000 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** "+1.2 GB" / "−300 MB". */
export const formatDelta = (n: number) => `${n >= 0 ? "+" : "−"}${formatBytes(Math.abs(n))}`;

export const formatCount = (n: number) => n.toLocaleString(i18n.language);

export const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

export const baseName = (p: string) => (p === "/" ? "/" : p.split("/").filter(Boolean).pop() ?? p);

export const parentDir = (p: string) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

/** "3 days ago" in the current UI language. */
export function timeAgo(unixSecs: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSecs);
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
  if (s < 60) return rtf.format(0, "second");
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  if (s < 86400 * 60) return rtf.format(-Math.floor(s / 86400), "day");
  if (s < 86400 * 730) return rtf.format(-Math.floor(s / (86400 * 30)), "month");
  return rtf.format(-Math.floor(s / (86400 * 365)), "year");
}
