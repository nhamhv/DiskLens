/** How safe deleting is: an allowlist, so only known junk is "safe". */
export type SafetyLevel = "safe" | "review" | "risky" | "unknown";
export type CategoryId =
  | "system"
  | "applications"
  | "developer"
  | "caches"
  | "logs"
  | "trash"
  | "appData"
  | "containers"
  | "mail"
  | "media"
  | "documents"
  | "downloads"
  | "other";

export interface Entry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  items: number;
  /** Set for entries from the scanned tree; absent for ones built in the UI. */
  category?: CategoryId;
  safety?: SafetyLevel;
  /** A bundle whose contents weren't kept; opening it rescans it. */
  collapsed?: boolean;
  /** Files only: last modified, unix seconds. */
  modified?: number;
  /** Bytes gained (+) or lost (−) since the previous scan of this folder. */
  delta?: number;
  /** Gone since the previous scan; `size` is 0. Not deletable. */
  removed?: boolean;
}

export interface Summary {
  path: string;
  /** Largest first. */
  categories: { key: CategoryId; size: number }[];
  safety: { key: SafetyLevel; size: number }[];
  /** Safe-to-clean items, largest first (capped; the counts cover all of them). */
  cleanup: Entry[];
  cleanupCount: number;
  cleanupSize: number;
}

export interface Listing {
  path: string;
  size: number;
  items: number;
  entries: Entry[];
  otherCount: number;
  otherSize: number;
  /** This folder's size in the previous scan, when there is one. */
  prevSize?: number | null;
}

export interface Progress {
  files: number;
  bytes: number;
  errors: number;
  current: string;
}

export interface ScanMeta {
  root: string;
  size: number;
  files: number;
  errors: number;
  /** Unix seconds. */
  scannedAt: number;
  /** 0 when loaded from cache. */
  elapsedMs: number;
  /** Size of the cached result on disk; only set by `listCaches`. */
  cacheBytes: number;
  /** When the scan that changes are compared against ran (unix seconds). */
  prevScannedAt?: number | null;
  /** Kept in memory instead of on disk, so it is gone when the app closes. */
  inMemory?: boolean;
}

/** Where saved scans go: `auto` picks disk unless it is nearly full. */
export type CacheMode = "auto" | "disk" | "memory";

export type Speed = "min" | "low" | "balanced" | "high" | "fast";

/** Logical CPUs and the scan threads each speed uses; see `threads_for` in src-tauri/src/state.rs. */
export type ThreadCounts = { cpus: number } & Record<Speed, number>;

export interface DiskInfo {
  total: number;
  free: number;
}

export interface DeleteResult {
  freed: number;
  deleted: string[];
  failed: { path: string; error: string }[];
}

export interface AppInfo {
  path: string;
  name: string;
  bundleId: string | null;
  version: string | null;
  build: string | null;
  lastUsed: number | null;
  source: "appstore" | "sparkle" | "other";
}

export interface DataPath {
  path: string;
  size: number;
  isDir: boolean;
}

export interface Footprint {
  path: string;
  bundle: number;
  data: DataPath[];
}

export interface UpdateInfo {
  path: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  error: string | null;
}

export type Safety = "safe" | "rebuild" | "caution";
export type DevCategory = "project" | "sdk" | "caches" | "ide" | "ai" | "old";

export interface DevItem {
  path: string;
  name: string;
  ruleId: string;
  label: string;
  eco: string;
  category: DevCategory;
  safety: Safety;
  restore: string | null;
  description: string | null;
  size: number;
  /** Unix seconds. */
  mtime: number;
  custom: boolean;
  viewOnly: boolean;
  /** Apps holding this folder open right now. */
  running: string[];
}

export interface DevWorktree {
  kind: "git" | "claude" | "codex";
  main: string | null;
  size: number;
}

export interface DevProject {
  path: string;
  name: string;
  ecos: string[];
  lastActive: number;
  worktree: DevWorktree | null;
  items: DevItem[];
}

export interface RuleWarning {
  file: string;
  line: number;
  col: number;
  message: string;
}

export interface DevReport {
  projects: DevProject[];
  items: DevItem[];
  warnings: RuleWarning[];
  /** `mtime` (ms) of the rules file as read for this scan. */
  rules: { path: string; mtime: number | null; builtin: number; custom: number; disabled: number };
  elapsedMs: number;
  /** Unix seconds. */
  scannedAt: number;
}

export interface DevProgress {
  phase: "locations" | "walk" | "git" | "measure";
  dirs: number;
  found: number;
  measured: number;
  total: number;
  bytes: number;
  current: string;
}

export interface WorktreeStatus {
  dirty: number;
  unpushed: number | null;
  branch: string | null;
}

export interface RulesFile {
  path: string;
  text: string;
  /** ms; null when the file doesn't exist yet (`text` is then the template). */
  mtime: number | null;
}

export interface RuleSummary {
  id: string;
  type: string | null;
  eco: string | null;
  label: string | null;
  safety: string | null;
  custom: boolean;
  overridden: boolean;
  disabled: boolean;
  broken: boolean;
  /** Built-in definition, pretty-printed. */
  builtin: string | null;
}

export interface RulesCheck {
  warnings: RuleWarning[];
  rules: RuleSummary[];
  builtin: number;
  custom: number;
  disabled: number;
}

export type RulesSave =
  | { status: "saved"; file: RulesFile }
  | { status: "conflict"; file: RulesFile }
  | { status: "invalid"; warnings: RuleWarning[] };

/** What this OS build supports; the UI hides the rest. */
export interface PlatformFeatures {
  os: "macos" | "linux" | "windows";
  apps: boolean;
  fullDiskAccess: boolean;
  hiddenSpace: boolean;
  quickLook: boolean;
  heic: boolean;
}

export interface HiddenSpace {
  /** Time Machine local snapshots, oldest first (`YYYY-MM-DD-HHMMSS`). */
  snapshots: string[];
  purgeable: number;
}

export interface Photo {
  path: string;
  name: string;
  size: number;
  modified: number;
  /** Focus score, lower is blurrier. Camera formats only. */
  sharpness?: number | null;
}

export interface PhotoReport {
  scanned: number;
  truncated: boolean;
  blurry: Photo[];
  screenshots: Photo[];
  /** The first photo of each group is the suggested one to keep. */
  similar: Photo[][];
}

export interface PhotoProgress {
  done: number;
  total: number;
}

export interface TelemetryStatus {
  /** False in builds without an Aptabase key; the UI then never asks. */
  available: boolean;
  /** null until the user has answered. */
  consent: boolean | null;
}

export interface CrashLog {
  name: string;
  /** Unix seconds. */
  modified: number;
  size: number;
}

export interface IssueReport {
  /** Shown to the user; the same text is in `url`. */
  body: string;
  url: string;
}
