//! Moving to Trash and permanent deletion, with a guard for system paths.

use crate::platform;
use crate::state::{blocking, save_in_background, AppState};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

fn is_protected(p: &Path) -> bool {
    if !p.is_absolute() || p.components().any(|c| c == Component::ParentDir) {
        return true;
    }
    const EXACT: &[&str] = &[
        "/", "/Applications", "/Library", "/System", "/Users", "/Volumes", "/private", "/usr",
        "/bin", "/sbin", "/etc", "/var", "/tmp", "/opt", "/cores",
        // Linux
        "/home", "/root", "/srv", "/media", "/mnt", "/snap", "/var/lib", "/lost+found",
    ];
    if EXACT.iter().any(|e| p == Path::new(e)) {
        return true;
    }
    const TREES: &[&str] = &[
        "/System", "/bin", "/sbin", "/private/var/db",
        // Linux
        "/boot", "/proc", "/sys", "/dev", "/run", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/var/lib/dpkg", "/var/lib/apt",
    ];
    if TREES.iter().any(|pre| p.starts_with(pre))
        || (p.starts_with("/usr") && !p.starts_with("/usr/local"))
    {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let keep = [
            "", ".Trash", "Library", "Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music",
            // Linux (XDG)
            "Videos", "Public", "Templates", ".config", ".local", ".local/share", ".local/share/Trash", ".cache",
        ];
        if keep.iter().any(|k| p == home.join(k)) {
            return true;
        }
    }
    false
}

/// Drops a deleted path from the tree. Returns bytes freed.
fn forget_path(app: &AppHandle, p: &Path) -> u64 {
    let state = app.state::<AppState>();
    let mut guard = state.tree.lock().unwrap();
    guard
        .as_mut()
        .and_then(|t| {
            let rel = t.rel(p).ok()?;
            t.node.remove(&rel)
        })
        .unwrap_or(0)
}

fn remove_now(p: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    if meta.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }
        .map_err(|e| format!("{e} — some items may already be gone; rescan this folder"))?;
    // Emptying the Linux Trash: drop the item's `.trashinfo` too, or it lingers as a broken entry.
    if let Some(info) = platform::trash_info(p) {
        let _ = fs::remove_file(info);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct DeleteFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
pub struct DeleteResult {
    /// Bytes removed from the scan tree (for Trash, freed only once it is emptied).
    pub freed: u64,
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
}

/// Deletes many paths: to the Trash (recoverable) or permanently.
/// Paths inside another selected folder are skipped, since the folder covers them.
#[tauri::command]
pub async fn delete_paths(paths: Vec<String>, permanent: bool, app: AppHandle) -> Result<DeleteResult, String> {
    let mut list: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    // The finished scan would overwrite the tree and bring deleted items back.
    if let Some((root, _)) = app.state::<AppState>().live.lock().unwrap().as_ref() {
        if list.iter().any(|p| p.starts_with(root)) {
            return Err("Wait for the scan to finish before deleting".into());
        }
    }
    list.sort();
    list.dedup();
    let mut roots: Vec<PathBuf> = Vec::new();
    for p in list {
        if !roots.last().is_some_and(|r| p.starts_with(r)) {
            roots.push(p);
        }
    }

    let mut result = DeleteResult { freed: 0, deleted: Vec::new(), failed: Vec::new() };
    for p in roots {
        let path = p.to_string_lossy().into_owned();
        let outcome = if is_protected(&p) {
            Err(format!("Refusing to delete protected path {path}"))
        } else {
            let target = p.clone();
            blocking(move || {
                if permanent {
                    remove_now(&target)
                } else {
                    trash::delete(&target).map_err(|e| e.to_string())
                }
            })
            .await
            .and_then(|r| r)
        };
        match outcome {
            Ok(()) => {
                result.freed += forget_path(&app, &p);
                result.deleted.push(path);
            }
            Err(error) => result.failed.push(DeleteFailure { path, error }),
        }
    }
    if !result.deleted.is_empty() {
        save_in_background(app);
    }
    Ok(result)
}

