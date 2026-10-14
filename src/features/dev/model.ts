import type { DevCategory, DevItem, DevProject, DevReport, Safety } from "@/lib/types";

export type Tab = "projects" | Exclude<DevCategory, "project"> | "worktrees";

export const TABS: Tab[] = ["projects", "sdk", "caches", "ide", "ai", "old", "worktrees"];

export type Age = 0 | 30 | 90 | 365;

export interface Filters {
  eco: string | null;
  safety: Safety[];
  /** Untouched for at least this many days; 0 = any. */
  age: Age;
}

/** Ecosystem names are product names, so they aren't translated. */
export const ECOS: Record<string, { label: string; color: string }> = {
  node: { label: "Node.js", color: "#84cc16" },
  rust: { label: "Rust", color: "#f97316" },
  python: { label: "Python", color: "#3b82f6" },
  apple: { label: "Xcode", color: "#a1a1aa" },
  android: { label: "Android", color: "#22c55e" },
  java: { label: "Java", color: "#ef4444" },
  flutter: { label: "Flutter", color: "#38bdf8" },
  php: { label: "PHP", color: "#818cf8" },
  ruby: { label: "Ruby", color: "#e11d48" },
  dotnet: { label: ".NET", color: "#8b5cf6" },
  go: { label: "Go", color: "#06b6d4" },
  elixir: { label: "Elixir", color: "#a855f7" },
  haskell: { label: "Haskell", color: "#7c3aed" },
  scala: { label: "Scala", color: "#dc2626" },
  cpp: { label: "C/C++", color: "#60a5fa" },
  zig: { label: "Zig", color: "#f59e0b" },
  gamedev: { label: "Unity/Godot", color: "#94a3b8" },
  terraform: { label: "Terraform", color: "#7b42bc" },
  editor: { label: "Editors", color: "#0ea5e9" },
  ai: { label: "AI", color: "#e879f9" },
  other: { label: "Other", color: "#71717a" },
};

export const eco = (id: string) => ECOS[id] ?? { label: id, color: ECOS.other.color };

const DAY = 86400;
export const now = () => Date.now() / 1000;
export const idleDays = (since: number) => (now() - since) / DAY;

/** A row can be ticked unless an app holds it or it's a view-only custom location. */
export const selectable = (i: DevItem) => !i.viewOnly && i.running.length === 0;

export function itemPasses(i: DevItem, f: Filters, activeAt: number) {
  return (!f.eco || i.eco === f.eco) && f.safety.includes(i.safety) && (f.age === 0 || idleDays(activeAt) >= f.age);
}

/** Projects with the items that pass the filters (projects with none are dropped). */
export function visibleProjects(r: DevReport, f: Filters): DevProject[] {
  return r.projects
    .map((p) => ({ ...p, items: p.items.filter((i) => itemPasses(i, f, p.lastActive)) }))
    .filter((p) => p.items.length > 0);
}

export function visibleWorktrees(r: DevReport, f: Filters): DevProject[] {
  return r.projects.filter(
    (p) =>
      p.worktree &&
      f.safety.includes("caution") &&
      (!f.eco || p.ecos.includes(f.eco)) &&
      (f.age === 0 || idleDays(p.lastActive) >= f.age),
  );
}

export const visibleItems = (r: DevReport, f: Filters, cat: DevCategory) =>
  r.items.filter((i) => i.category === cat && itemPasses(i, f, i.mtime));

export const sum = (xs: { size: number }[]) => xs.reduce((s, x) => s + x.size, 0);

/** Drops paths inside another selected path: deleting the parent covers them. */
export function topLevel(paths: Iterable<string>): string[] {
  const sorted = [...paths].sort();
  const out: string[] = [];
  for (const p of sorted) if (!out.some((o) => p.startsWith(o + "/"))) out.push(p);
  return out;
}

/** Removes deleted paths (and anything inside them) from a report. */
export function withoutPaths(r: DevReport, gone: Set<string>): DevReport {
  const isGone = (p: string) => gone.has(p) || [...gone].some((g) => p.startsWith(g + "/"));
  return {
    ...r,
    items: r.items.filter((i) => !isGone(i.path)),
    projects: r.projects
      .filter((p) => !isGone(p.path))
      .map((p) => ({ ...p, items: p.items.filter((i) => !isGone(i.path)) }))
      .filter((p) => p.items.length > 0 || p.worktree),
  };
}

export const tildify = (p: string, home: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
