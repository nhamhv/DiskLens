//! Developer cleanup: scanning for regenerable dev data, worktree checks, the rules file.

use crate::dev::{self, git, rules};
use crate::state::{blocking, build_pool, cache_dir, AppState, Speed};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

/// `~/.config/disklens/rules.json`: plain to find and edit, and kept when the app is reinstalled.
fn rules_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".config/disklens/rules.json"))
}

/// Scans `folders` for project artifacts and checks every fixed location. The rules file
/// is re-read each time. Emits `dev-progress` every 200 ms. `None` if cancelled.
#[tauri::command]
pub async fn dev_scan(folders: Vec<String>, speed: Speed, app: AppHandle) -> Result<Option<dev::DevReport>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = app.state::<AppState>().dev_cancel.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    let home = home()?;
    let path = rules_path()?;
    blocking(move || {
        // Before reading, so an edit made during the read still counts as newer.
        let rules_mtime = mtime_ms(&path);
        let catalog = rules::load(Some(&path));
        let progress = Arc::new(dev::Progress::default());
        let done = Arc::new(AtomicBool::new(false));
        let ticker = {
            let (progress, done, app) = (progress.clone(), done.clone(), app.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    let _ = app.emit("dev-progress", progress.snapshot());
                    std::thread::sleep(Duration::from_millis(200));
                }
            })
        };
        let folders: Vec<PathBuf> = folders.iter().map(PathBuf::from).collect();
        let report = build_pool(speed).install(|| {
            dev::scan(dev::ScanInput {
                folders: &folders,
                catalog: &catalog,
                rules_path: &path,
                rules_mtime,
                home: &home,
                cancel: &cancel,
                progress: &progress,
            })
        });
        done.store(true, Ordering::Relaxed);
        let _ = ticker.join();
        if let (Some(r), Ok(dir)) = (&report, cache_dir(&app)) {
            let _ = dev::save_report(&dir, r);
        }
        report
    })
    .await
}

/// The last scan's report, saved on disk, without items deleted since. `None` if there is none.
#[tauri::command]
pub async fn dev_cached_report(app: AppHandle) -> Result<Option<dev::DevReport>, String> {
    let dir = cache_dir(&app)?;
    blocking(move || dev::load_report(&dir)).await
}

#[tauri::command]
pub fn dev_cancel(state: State<AppState>) {
    if let Some(flag) = state.dev_cancel.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Uncommitted files and unpushed commits of a worktree, checked before deleting it.
#[tauri::command]
pub async fn dev_worktree_status(path: String) -> Result<git::WorktreeStatus, String> {
    blocking(move || git::worktree_status(&PathBuf::from(path))).await?
}

/// After worktree folders are deleted, drops their records from the main repositories.
#[tauri::command]
pub async fn dev_prune_worktrees(repos: Vec<String>) -> Result<(), String> {
    blocking(move || repos.iter().for_each(|r| git::prune_worktrees(&PathBuf::from(r)))).await
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let t = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesFile {
    pub path: String,
    pub text: String,
    /// None when the file doesn't exist yet; `text` is then the commented template.
    pub mtime: Option<u64>,
}

fn read_rules() -> Result<RulesFile, String> {
    let path = rules_path()?;
    let mtime = mtime_ms(&path);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => rules::TEMPLATE.to_string(),
        Err(e) => return Err(e.to_string()),
    };
    Ok(RulesFile { path: path.to_string_lossy().into_owned(), text, mtime })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesCheck {
    pub warnings: Vec<rules::Warning>,
    pub rules: Vec<rules::RuleSummary>,
    pub builtin: usize,
    pub custom: usize,
    pub disabled: usize,
}

fn check(text: &str) -> RulesCheck {
    let cat = rules::load_text("rules.json", Some(text));
    RulesCheck { warnings: cat.warnings, rules: cat.summary, builtin: cat.builtin, custom: cat.custom, disabled: cat.disabled }
}

/// The user's rules file, or the commented template if there is none yet.
#[tauri::command]
pub async fn dev_rules_read() -> Result<RulesFile, String> {
    blocking(read_rules).await?
}

/// mtime (ms) of the rules file, polled to notice edits made outside the app.
#[tauri::command]
pub fn dev_rules_stat() -> Result<Option<u64>, String> {
    Ok(mtime_ms(&rules_path()?))
}

/// Validates unsaved text exactly as a scan would read it.
#[tauri::command]
pub async fn dev_rules_check(text: String) -> Result<RulesCheck, String> {
    blocking(move || check(&text)).await
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved { file: RulesFile },
    /// Changed on disk since `expected` was read; nothing written.
    Conflict { file: RulesFile },
    /// Has problems; nothing written.
    Invalid { warnings: Vec<rules::Warning> },
}

/// Saves the rules file if `text` has no problems and the file on disk is still the one
/// the editor loaded (`expected` mtime; `force` overwrites anyway). Writes a temp file and
/// renames it over, so a crash never leaves half a file.
#[tauri::command]
pub async fn dev_rules_save(text: String, expected: Option<u64>, force: bool) -> Result<SaveOutcome, String> {
    blocking(move || {
        let warnings = check(&text).warnings;
        if !warnings.is_empty() {
            return Ok(SaveOutcome::Invalid { warnings });
        }
        let path = rules_path()?;
        if !force && mtime_ms(&path) != expected {
            return Ok(SaveOutcome::Conflict { file: read_rules()? });
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(SaveOutcome::Saved { file: read_rules()? })
    })
    .await?
}
