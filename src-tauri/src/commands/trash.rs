//! The user's Trash, so the welcome screen can offer to empty it.
//! Emptying goes through `delete_paths`, like any other permanent delete.

use super::scan::{entry, Entry};
use crate::classify::Classifier;
use crate::platform;
use crate::scanner::{self, ScanCtx};
use crate::state::{blocking, build_pool, Speed};
use std::fs;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Top-level items in the user's Trash with their sizes, largest first. `None` when the Trash
/// can't be read, which on macOS is the case without Full Disk Access.
#[tauri::command]
pub async fn trash_contents() -> Result<Option<Vec<Entry>>, String> {
    let Some(dir) = platform::trash_files() else {
        return Ok(None);
    };
    blocking(move || {
        fs::read_dir(&dir).ok()?;
        let ctx = ScanCtx::new(&dir, Arc::new(AtomicBool::new(false)));
        let node = build_pool(Speed::Low).install(|| scanner::scan_root(&dir, &ctx, &|_| {}))?;
        // Finder keeps a .DS_Store in an otherwise empty Trash.
        let c = Classifier::from_env();
        let class = c.classify(&dir, true);
        Some(node.children.iter().filter(|n| n.name != ".DS_Store").map(|n| entry(&c, &dir, class, n)).collect())
    })
    .await
}
