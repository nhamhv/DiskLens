//! Shared app state and helpers used by several command modules.

use crate::cache::{self, ScanMeta, ScanTree};
use crate::scanner::{Node, ScanCtx};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

impl ScanTree {
    pub fn rel(&self, path: &Path) -> Result<Vec<String>, String> {
        let rel = path
            .strip_prefix(&self.root)
            .map_err(|_| format!("{} is outside the scanned folder", path.display()))?;
        Ok(rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect())
    }

    pub fn find(&self, path: &Path) -> Result<&Node, String> {
        self.node
            .find(&self.rel(path)?)
            .ok_or_else(|| format!("{} not found in scan", path.display()))
    }
}

#[derive(Default)]
pub struct AppState {
    pub tree: Mutex<Option<ScanTree>>,
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// The scan in progress (root + context), so finished folders can be browsed early.
    pub live: Mutex<Option<(PathBuf, Arc<ScanCtx>)>>,
    /// Cancels the running developer scan.
    pub dev_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub photos_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Serialises cache writes so two saves never race on the same file.
    pub saving: Mutex<()>,
}

impl AppState {
    pub fn cancel_current(&self) {
        if let Some(flag) = self.cancel.lock().unwrap().take() {
            flag.store(true, Ordering::Relaxed);
        }
        *self.live.lock().unwrap() = None;
    }

    /// Runs `f` on the node at `path`: from the finished tree, or, while a scan is running,
    /// from a top-level folder that is already fully sized.
    pub fn with_node<R>(&self, path: &Path, f: impl FnOnce(&Node) -> R) -> Result<R, String> {
        let tree = self.tree.lock().unwrap();
        if let Some(t) = tree.as_ref() {
            return t.find(path).map(f);
        }
        let live = self.live.lock().unwrap();
        let (root, ctx) = live.as_ref().ok_or("No scan result yet")?;
        let rel: Vec<String> = path
            .strip_prefix(root)
            .map_err(|_| format!("{} is outside the scanned folder", path.display()))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let done = ctx.done.lock().unwrap();
        rel.split_first()
            .and_then(|(top, rest)| done.iter().find(|n| &n.name == top)?.find(rest))
            .map(f)
            .ok_or_else(|| format!("{} is still being scanned", path.display()))
    }
}

/// How hard the scanner may push the machine.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Speed {
    /// 2 threads at the lowest CPU and disk priority, so the machine stays responsive.
    Low,
    Balanced,
    Fast,
}

pub fn build_pool(speed: Speed) -> rayon::ThreadPool {
    let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
    let threads = match speed {
        Speed::Low => 2,
        Speed::Balanced => (cpus / 2).max(2),
        // Directory walking is I/O bound, so oversubscribe the CPU count.
        Speed::Fast => cpus * 2,
    };
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .start_handler(move |_| crate::platform::set_thread_priority(speed))
        .build()
        .expect("failed to build scan thread pool")
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

pub fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_cache_dir().map_err(|e| e.to_string())
}

pub fn write_cache(app: &AppHandle, meta: &ScanMeta, bytes: &[u8]) {
    let state = app.state::<AppState>();
    let _guard = state.saving.lock().unwrap();
    if let Ok(dir) = cache_dir(app) {
        let _ = cache::write(&dir, meta, bytes);
    }
}

/// Re-saves the current tree after it was edited (trash, folder rescan).
pub fn save_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let encoded = {
            let guard = state.tree.lock().unwrap();
            guard.as_ref().map(|t| (t.meta(0), cache::encode(t)))
        };
        if let Some((meta, Ok(bytes))) = encoded {
            write_cache(&app, &meta, &bytes);
        }
    });
}

/// Runs blocking filesystem work off the async runtime.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}
