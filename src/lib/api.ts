import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, CrashLog, IssueReport, TelemetryStatus, DeleteResult, DevReport, DiskInfo, HiddenSpace, PhotoReport, PlatformFeatures, RulesCheck, RulesFile, RulesSave, WorktreeStatus, UpdateInfo, Entry, Listing, ScanMeta, CacheMode, Speed, Summary, ThreadCounts } from "@/lib/types";

export const api = {
  startScan: (path: string, speed: Speed) => invoke<void>("start_scan", { path, speed }),
  cancelScan: () => invoke<void>("cancel_scan"),
  rescanFolder: (path: string, speed: Speed) => invoke<void>("rescan_folder", { path, speed }),
  loadCache: (path: string) => invoke<ScanMeta | null>("load_cache", { path }),
  listCaches: () => invoke<ScanMeta[]>("list_caches"),
  forgetCache: (path: string) => invoke<void>("forget_cache", { path }),
  clearCaches: () => invoke<number>("clear_caches"),
  scanThreads: () => invoke<ThreadCounts>("scan_threads"),
  setCacheMode: (mode: CacheMode) => invoke<void>("set_cache_mode", { mode }),
  /** Top-level Trash items, or null when the Trash can't be read (no Full Disk Access). */
  trashContents: () => invoke<Entry[] | null>("trash_contents"),
  listChildren: (path: string) => invoke<Listing>("list_children", { path }),
  /** With `modifiedBefore` (unix seconds), only files last modified before then. */
  largestFiles: (path: string, limit = 200, modifiedBefore?: number) =>
    invoke<Entry[]>("largest_files", { path, limit, modifiedBefore: modifiedBefore ?? null }),
  /** What grew or shrank under `path` since the previous scan, biggest change first. */
  scanChanges: (path: string, limit = 300) => invoke<Entry[]>("scan_changes", { path, limit }),
  /** Sizes by category and safety under `path`, plus its safe-to-clean items. */
  scanSummary: (path: string) => invoke<Summary>("scan_summary", { path }),
  deletePaths: (paths: string[], permanent: boolean) => invoke<DeleteResult>("delete_paths", { paths, permanent }),
  listApps: () => invoke<AppInfo[]>("list_apps"),
  appIcon: (path: string) => invoke<string | null>("app_icon", { path }),
  appFootprints: (paths: string[], speed: Speed) => invoke<void>("app_footprints", { paths, speed }),
  checkAppUpdates: (paths: string[]) => invoke<UpdateInfo[]>("check_app_updates", { paths }),
  platformFeatures: () => invoke<PlatformFeatures>("platform_features"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  isDir: (path: string) => invoke<boolean>("is_dir", { path }),
  quitApp: () => invoke<void>("quit_app"),
  /** Toggles a Quick Look preview (macOS). Resolves to whether a preview is now open. */
  quickLook: (paths: string[]) => invoke<boolean>("quick_look", { paths }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  copyPath: (path: string) => invoke<void>("copy_path", { path }),
  openFullDiskAccessSettings: () => invoke<void>("open_full_disk_access_settings"),
  hasFullDiskAccess: () => invoke<boolean>("has_full_disk_access"),
  diskInfo: () => invoke<DiskInfo>("disk_info"),
  hiddenSpace: () => invoke<HiddenSpace>("hidden_space"),
  /** Deletes Time Machine local snapshots; resolves to how many are left. */
  thinSnapshots: () => invoke<number>("thin_snapshots"),
  /** Null when cancelled or replaced by a newer scan. */
  photosScan: (folders: string[], speed: Speed) => invoke<PhotoReport | null>("photos_scan", { folders, speed }),
  photosCancel: () => invoke<void>("photos_cancel"),
  /** JPEG data URL, or null if the image can't be decoded. */
  photoThumb: (path: string, size?: number) => invoke<string | null>("photo_thumb", { path, size: size ?? null }),
  /** Null when a newer scan or devCancel stopped this one. */
  devScan: (folders: string[], speed: Speed) => invoke<DevReport | null>("dev_scan", { folders, speed }),
  devCancel: () => invoke<void>("dev_cancel"),
  /** The last scan, saved on disk, minus items deleted since. */
  devCachedReport: () => invoke<DevReport | null>("dev_cached_report"),
  devWorktreeStatus: (path: string) => invoke<WorktreeStatus>("dev_worktree_status", { path }),
  devPruneWorktrees: (repos: string[]) => invoke<void>("dev_prune_worktrees", { repos }),
  /** The user's rules file, or the commented template if it doesn't exist yet. */
  devRulesRead: () => invoke<RulesFile>("dev_rules_read"),
  devRulesStat: () => invoke<number | null>("dev_rules_stat"),
  devRulesCheck: (text: string) => invoke<RulesCheck>("dev_rules_check", { text }),
  telemetryStatus: () => invoke<TelemetryStatus>("telemetry_status"),
  telemetrySetConsent: (agreed: boolean) => invoke<void>("telemetry_set_consent", { agreed }),
  /** Crash reports saved on this machine, newest first. */
  listCrashLogs: () => invoke<CrashLog[]>("list_crash_logs"),
  openCrashFolder: () => invoke<void>("open_crash_folder"),
  logUiError: (message: string, stack: string) => invoke<void>("log_ui_error", { message, stack }),
  issueReport: () => invoke<IssueReport>("issue_report"),
  openIssue: (url: string) => invoke<void>("open_issue", { url }),
  /** Writes only if `text` is valid and the file still has mtime `expected` (unless `force`). */
  devRulesSave: (text: string, expected: number | null, force = false) =>
    invoke<RulesSave>("dev_rules_save", { text, expected, force }),
};
