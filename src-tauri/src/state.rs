//! Shared app state and helpers used by several command modules.

use crate::cache::{self, CacheMode, ScanMeta, ScanTree};
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
    /// Where `write_cache` puts scans; set from the UI.
    pub cache_mode: Mutex<CacheMode>,
    /// Scans kept in RAM (newest first) when the disk is nearly full or the user chose so.
    pub mem_caches: Mutex<Vec<(ScanMeta, Vec<u8>)>>,
}

/// Scans kept in memory at once; each can be hundreds of MB.
const MAX_MEM_CACHES: usize = 3;

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
    /// One thread at the lowest CPU and disk priority.
    Min,
    /// A third of the CPUs, at the lowest priority, so the machine stays responsive.
    Low,
    /// Two thirds of the CPUs; the default.
    Balanced,
    /// All CPUs at normal priority.
    High,
    Fast,
}

pub fn cpu_threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get())
}

/// Scan threads for `speed` on a machine with `cpus` logical CPUs (never fewer than one).
pub fn threads_for(speed: Speed, cpus: usize) -> usize {
    match speed {
        Speed::Min => 1,
        Speed::Low => cpus / 3,
        Speed::Balanced => cpus * 2 / 3,
        Speed::High => cpus,
        // Directory walking is I/O bound, so oversubscribe the CPU count.
        Speed::Fast => cpus * 2,
    }
    .max(1)
}

pub fn build_pool(speed: Speed) -> rayon::ThreadPool {
    let threads = threads_for(speed, cpu_threads());
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

/// Saves an encoded scan: to disk, or to memory when the disk is nearly full (or the user chose
/// memory) or the write fails.
pub fn write_cache(app: &AppHandle, meta: &ScanMeta, bytes: Vec<u8>) {
    let state = app.state::<AppState>();
    let _guard = state.saving.lock().unwrap();
    let root = Path::new(&meta.root);
    let dir = cache_dir(app).ok();
    let to_memory = match (*state.cache_mode.lock().unwrap(), &dir) {
        (_, None) | (CacheMode::Memory, _) => true,
        (CacheMode::Disk, _) => false,
        (CacheMode::Auto, Some(dir)) => cache::low_on_space(dir, bytes.len() as u64),
    };
    if !to_memory {
        if let Some(dir) = &dir {
            if cache::write(dir, meta, &bytes).is_ok() {
                state.mem_caches.lock().unwrap().retain(|(m, _)| m.root != meta.root);
                return;
            }
        }
    }
    // The old file for this root is stale now, and dropping it frees space on a full disk.
    if let Some(dir) = &dir {
        cache::remove(dir, root);
    }
    let mut kept = meta.clone();
    kept.in_memory = true;
    kept.cache_bytes = bytes.len() as u64;
    let mut mem = state.mem_caches.lock().unwrap();
    mem.retain(|(m, _)| m.root != meta.root);
    mem.insert(0, (kept, bytes));
    mem.truncate(MAX_MEM_CACHES);
}

/// The saved scan of `root`, from memory or disk.
pub fn cached_tree(app: &AppHandle, root: &Path) -> Option<ScanTree> {
    let state = app.state::<AppState>();
    let mem = state.mem_caches.lock().unwrap().iter().find(|(m, _)| Path::new(&m.root) == root).map(|(_, b)| cache::decode(b));
    match mem {
        Some(tree) => tree,
        None => cache::load(&cache_dir(app).ok()?, root),
    }
}

/// Just the tree of the saved scan of `root`, for comparing with a new scan.
pub fn cached_node(app: &AppHandle, root: &Path) -> Option<(u64, Node)> {
    let state = app.state::<AppState>();
    let mem = state.mem_caches.lock().unwrap().iter().find(|(m, _)| Path::new(&m.root) == root).map(|(_, b)| cache::node_from_bytes(b));
    match mem {
        Some(node) => node,
        None => cache::load_node(&cache_dir(app).ok()?, root),
    }
}

/// Every saved scan, memory and disk, newest first.
pub fn list_caches(app: &AppHandle) -> Vec<ScanMeta> {
    let state = app.state::<AppState>();
    let mut all: Vec<ScanMeta> = state.mem_caches.lock().unwrap().iter().map(|(m, _)| m.clone()).collect();
    if let Ok(dir) = cache_dir(app) {
        let on_disk: Vec<ScanMeta> = cache::list(&dir).into_iter().filter(|d| !all.iter().any(|m| m.root == d.root)).collect();
        all.extend(on_disk);
    }
    all.sort_by_key(|m| std::cmp::Reverse(m.scanned_at));
    all
}

pub fn forget_cache(app: &AppHandle, root: &Path) {
    let state = app.state::<AppState>();
    state.mem_caches.lock().unwrap().retain(|(m, _)| Path::new(&m.root) != root);
    if let Ok(dir) = cache_dir(app) {
        cache::remove(&dir, root);
    }
}

/// Forgets every saved scan; returns the bytes freed.
pub fn clear_caches(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let in_memory: u64 = state.mem_caches.lock().unwrap().drain(..).map(|(_, b)| b.len() as u64).sum();
    in_memory + cache_dir(app).map_or(0, |dir| cache::clear(&dir))
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
            write_cache(&app, &meta, bytes);
        }
    });
}

/// Runs blocking filesystem work off the async runtime.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_levels_scale_with_the_cpu_count() {
        let t = |s, cpus| threads_for(s, cpus);
        assert_eq!([t(Speed::Min, 16), t(Speed::Low, 16), t(Speed::Balanced, 16), t(Speed::High, 16), t(Speed::Fast, 16)], [1, 5, 10, 16, 32]);
        assert_eq!([t(Speed::Min, 4), t(Speed::Low, 4), t(Speed::Balanced, 4), t(Speed::High, 4), t(Speed::Fast, 4)], [1, 1, 2, 4, 8]);
        // A single CPU still gets a thread at every level.
        assert!([Speed::Min, Speed::Low, Speed::Balanced, Speed::High, Speed::Fast].iter().all(|&s| t(s, 1) >= 1));
    }
}
