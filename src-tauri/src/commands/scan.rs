//! Scanning, cached results and browsing the scanned tree.

use crate::cache::{self, Prev, ScanMeta, ScanTree};
use crate::classify::{self, Category, Class, Classifier, Safety, Tally};
use crate::scanner::{self, Node, ScanCtx};
use crate::state::{blocking, build_pool, cache_dir, now_secs, save_in_background, write_cache, AppState, Speed};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Max children sent to the UI per folder; the rest are summarised.
/// The sidebar renders lazily, so this only guards against folders with huge numbers of items.
const LIST_LIMIT: usize = 20_000;

/// The previous scan keeps only items at least this big. Missing items count as 0,
/// so a change is off by less than this.
const PREV_MIN: u64 = 1 << 20;
/// Smallest change listed by `scan_changes`.
const CHANGE_MIN: u64 = 10_000_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub items: usize,
    pub category: Category,
    pub safety: Safety,
    /// A bundle whose contents weren't kept; opening it means rescanning it.
    pub collapsed: bool,
    /// Files: last modified, unix seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    /// Size change since the previous scan, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<i64>,
    /// Gone since the previous scan (only in `scan_changes`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub removed: bool,
}

fn modified(n: &Node) -> Option<u64> {
    (n.modified > 0).then_some(n.modified as u64)
}

/// `parent` is the folder `n` sits in, `class` that folder's class.
pub(crate) fn entry(c: &Classifier, parent: &Path, class: Class, n: &Node) -> Entry {
    let path = parent.join(&n.name);
    let cls = c.step(class, &path, n.is_dir);
    Entry {
        name: n.name.clone(),
        path: path.to_string_lossy().into_owned(),
        size: n.size,
        is_dir: n.is_dir,
        items: n.children.len(),
        category: cls.category,
        safety: cls.safety,
        collapsed: n.is_dir && n.children.is_empty() && classify::is_bundle(&n.name),
        modified: modified(n),
        delta: None,
        removed: false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub size: u64,
    pub items: usize,
    pub entries: Vec<Entry>,
    pub other_count: usize,
    pub other_size: u64,
    /// This folder's size in the previous scan, when there is one.
    pub prev_size: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub files: u64,
    pub bytes: u64,
    pub errors: u64,
    pub current: String,
}

impl Progress {
    fn of(ctx: &ScanCtx) -> Self {
        Self {
            files: ctx.files.load(Ordering::Relaxed),
            bytes: ctx.bytes.load(Ordering::Relaxed),
            errors: ctx.errors.load(Ordering::Relaxed),
            current: ctx.current.lock().unwrap().clone(),
        }
    }
}

/// Starts a background scan. Emits `scan-progress`, `scan-entry` (each finished
/// top-level folder) and finally `scan-done`. A new scan cancels the previous one.
#[tauri::command]
pub fn start_scan(path: String, speed: Speed, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    state.cancel_current();
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().unwrap() = Some(cancel.clone());
    // The result being replaced becomes the one to compare against.
    let previous = state.tree.lock().unwrap().take().filter(|t| t.root == root);

    let ctx = Arc::new(ScanCtx::new(&root, cancel.clone()));
    *state.live.lock().unwrap() = Some((root.clone(), ctx.clone()));

    std::thread::spawn(move || {
        let started = Instant::now();
        // Loading the previous result from disk can take a moment; do it while scanning.
        let prev_job = {
            let (app, root) = (app.clone(), root.clone());
            std::thread::spawn(move || {
                let (scanned_at, node) = match previous {
                    Some(t) => (t.scanned_at, t.node),
                    None => cache::load_node(&cache_dir(&app).ok()?, &root)?,
                };
                Some(Prev { scanned_at, node: node.pruned(PREV_MIN) })
            })
        };
        let done = Arc::new(AtomicBool::new(false));
        let ticker = {
            let (ctx, done, app) = (ctx.clone(), done.clone(), app.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) && !ctx.cancel.load(Ordering::Relaxed) {
                    let _ = app.emit("scan-progress", Progress::of(&ctx));
                    std::thread::sleep(Duration::from_millis(200));
                }
            })
        };

        let result = {
            let c = Classifier::from_env();
            let class = c.classify(&root, true);
            let on_child = |n: &Node| {
                let _ = app.emit("scan-entry", entry(&c, &root, class, n));
            };
            build_pool(speed).install(|| scanner::scan_root(&root, &ctx, &on_child))
        };
        done.store(true, Ordering::Relaxed);
        let _ = ticker.join();

        let Some(node) = result else { return };
        let tree = ScanTree {
            root,
            scanned_at: now_secs(),
            files: ctx.files.load(Ordering::Relaxed),
            errors: ctx.errors.load(Ordering::Relaxed),
            node,
            prev: prev_job.join().ok().flatten(),
        };
        let meta = tree.meta(started.elapsed().as_millis() as u64);
        // Encode before taking the lock so the UI can browse immediately after `scan-done`.
        let encoded = cache::encode(&tree);

        let state = app.state::<AppState>();
        {
            let mut slot = state.tree.lock().unwrap();
            // Checked under the lock so a superseded scan can never overwrite a newer one.
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            *slot = Some(tree);
            *state.live.lock().unwrap() = None;
        }
        let _ = app.emit("scan-done", meta.clone());
        if let Ok(bytes) = encoded {
            write_cache(&app, &meta, &bytes);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_scan(state: State<AppState>) {
    state.cancel_current();
}

/// Rescans one folder and splices it into the existing tree — much cheaper than
/// a full rescan when the user only changed something in one place.
#[tauri::command]
pub async fn rescan_folder(path: String, speed: Speed, app: AppHandle) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let (root, rel) = {
        let state = app.state::<AppState>();
        let guard = state.tree.lock().unwrap();
        let t = guard.as_ref().ok_or("No scan result yet")?;
        (t.root.clone(), t.rel(&p)?)
    };
    if rel.is_empty() {
        return Err("Use a full rescan for the root folder".into());
    }

    let scan_root = root.clone();
    let fresh = blocking(move || {
        let ctx = ScanCtx::new(&scan_root, Arc::new(AtomicBool::new(false)));
        build_pool(speed).install(|| scanner::scan_root(&p, &ctx, &|_| {}))
    })
    .await?;

    {
        let state = app.state::<AppState>();
        let mut guard = state.tree.lock().unwrap();
        let t = guard.as_mut().filter(|t| t.root == root).ok_or("Scan changed while rescanning")?;
        match fresh {
            Some(node) => t.node.replace(&rel, node),
            None => t.node.remove(&rel).map(|_| ()), // folder vanished
        };
    }
    save_in_background(app);
    Ok(())
}

/// Loads a cached scan for `path`, if one exists, and makes it current.
#[tauri::command]
pub async fn load_cache(path: String, app: AppHandle) -> Result<Option<ScanMeta>, String> {
    let dir = cache_dir(&app)?;
    let Some(tree) = blocking(move || cache::load(&dir, Path::new(&path))).await? else {
        return Ok(None);
    };
    let meta = tree.meta(0);
    let state = app.state::<AppState>();
    state.cancel_current();
    *state.tree.lock().unwrap() = Some(tree);
    Ok(Some(meta))
}

#[tauri::command]
pub fn list_caches(app: AppHandle) -> Result<Vec<ScanMeta>, String> {
    Ok(cache::list(&cache_dir(&app)?))
}

#[tauri::command]
pub fn forget_cache(path: String, app: AppHandle) -> Result<(), String> {
    cache::remove(&cache_dir(&app)?, Path::new(&path));
    Ok(())
}

/// Forgets every cached scan; returns the bytes freed.
#[tauri::command]
pub fn clear_caches(app: AppHandle) -> Result<u64, String> {
    Ok(cache::clear(&cache_dir(&app)?))
}

#[tauri::command]
pub fn list_children(path: String, state: State<AppState>) -> Result<Listing, String> {
    let dir = PathBuf::from(&path);
    let c = Classifier::from_env();
    let class = c.classify(&dir, true);
    let prev = prev_sizes(&state, &dir);
    state.with_node(&dir, |node| Listing {
        size: node.size,
        items: node.children.len(),
        entries: node
            .children
            .iter()
            .take(LIST_LIMIT)
            .map(|n| Entry {
                delta: prev.as_ref().map(|(_, p)| n.size as i64 - p.get(&n.name).copied().unwrap_or(0) as i64),
                ..entry(&c, &dir, class, n)
            })
            .collect(),
        other_count: node.children.len().saturating_sub(LIST_LIMIT),
        other_size: node.children.iter().skip(LIST_LIMIT).map(|c| c.size).sum(),
        prev_size: prev.as_ref().map(|(size, _)| *size),
        path: path.clone(),
    })
}

/// `dir`'s size in the previous scan and its children's sizes, if there is a previous scan.
/// Anything the pruned previous tree no longer has was smaller than `PREV_MIN`, so 0.
fn prev_sizes(state: &AppState, dir: &Path) -> Option<(u64, HashMap<String, u64>)> {
    let tree = state.tree.lock().unwrap();
    let t = tree.as_ref()?;
    let prev = t.prev.as_ref()?;
    Some(match t.rel(dir).ok().and_then(|rel| prev.node.find(&rel)) {
        Some(n) => (n.size, n.children.iter().map(|c| (c.name.clone(), c.size)).collect()),
        None => (0, HashMap::new()),
    })
}

/// The biggest changes under `path` since the previous scan, largest first. A folder whose
/// change is mostly explained by its children is replaced by them, so the list points at
/// what actually grew rather than at every ancestor.
#[tauri::command]
pub async fn scan_changes(path: String, limit: usize, app: AppHandle) -> Result<Vec<Entry>, String> {
    blocking(move || {
        let dir = PathBuf::from(&path);
        let state = app.state::<AppState>();
        let tree = state.tree.lock().unwrap();
        let t = tree.as_ref().ok_or("No scan result yet")?;
        let Some(prev) = &t.prev else { return Ok(Vec::new()) };
        let rel = t.rel(&dir)?;
        let cur = t.find(&dir)?;
        let empty = Node { name: String::new(), size: 0, is_dir: true, modified: 0, children: Vec::new() };
        let old = prev.node.find(&rel).unwrap_or(&empty);
        let mut out = Vec::new();
        collect_changes(cur, old, &dir, &mut out);
        out.sort_unstable_by_key(|ch| Reverse(ch.delta.unsigned_abs()));
        out.truncate(limit);
        let c = Classifier::from_env();
        Ok(out
            .into_iter()
            .map(|ch| {
                let size = ch.now.map_or(0, |n| n.size);
                let items = ch.now.map_or(0, |n| n.children.len());
                Entry {
                    modified: ch.now.and_then(modified),
                    delta: Some(ch.delta),
                    removed: ch.now.is_none(),
                    ..loose_entry(&c, ch.path, ch.is_dir, size, items)
                }
            })
            .collect())
    })
    .await?
}

struct Change<'a> {
    path: PathBuf,
    is_dir: bool,
    now: Option<&'a Node>,
    delta: i64,
}

/// Differences between the children of `cur` and of `old` (the same folder in the pruned
/// previous scan, where missing items count as 0).
fn child_changes<'a>(cur: &'a Node, old: &'a Node) -> Vec<(&'a str, Option<&'a Node>, Option<&'a Node>, i64)> {
    let before: HashMap<&str, &Node> = old.children.iter().map(|n| (n.name.as_str(), n)).collect();
    let mut out: Vec<_> = cur
        .children
        .iter()
        .map(|n| {
            let o = before.get(n.name.as_str()).copied();
            (n.name.as_str(), Some(n), o, n.size as i64 - o.map_or(0, |o| o.size as i64))
        })
        .collect();
    let now: std::collections::HashSet<&str> = cur.children.iter().map(|n| n.name.as_str()).collect();
    out.extend(old.children.iter().filter(|o| !now.contains(o.name.as_str())).map(|o| (o.name.as_str(), None, Some(o), -(o.size as i64))));
    out.retain(|c| c.3.unsigned_abs() >= CHANGE_MIN);
    out
}

fn collect_changes<'a>(cur: &'a Node, old: &'a Node, path: &Path, out: &mut Vec<Change<'a>>) {
    for (name, now, before, delta) in child_changes(cur, old) {
        let p = path.join(name);
        if let (Some(n), Some(b)) = (now, before) {
            if n.is_dir && b.is_dir {
                let inner = child_changes(n, b);
                let explained: i64 = inner.iter().filter(|c| c.3.signum() == delta.signum()).map(|c| c.3).sum();
                if explained.unsigned_abs() * 10 >= delta.unsigned_abs() * 8 {
                    collect_changes(n, b, &p, out);
                    continue;
                }
            }
        }
        let is_dir = now.or(before).is_some_and(|n| n.is_dir);
        out.push(Change { path: p, is_dir, now, delta });
    }
}

#[tauri::command]
/// The `limit` largest files under `path`; with `modified_before` (unix seconds), only files
/// last modified before then.
pub async fn largest_files(
    path: String,
    limit: usize,
    modified_before: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<Entry>, String> {
    let dir = PathBuf::from(&path);
    let mut heap = BinaryHeap::new();
    let keep = |n: &Node| modified_before.is_none_or(|before| n.modified > 0 && (n.modified as u64) < before);
    state.with_node(&dir, |node| collect_largest(node, &dir, limit, &keep, &mut heap))?;

    let mut files: Vec<(u64, PathBuf, u32)> = heap.into_iter().map(|Reverse(f)| f).collect();
    files.sort_unstable_by_key(|f| Reverse(f.0));
    let c = Classifier::from_env();
    Ok(files
        .into_iter()
        .map(|(size, p, m)| Entry { modified: (m > 0).then_some(m as u64), ..loose_entry(&c, p, false, size, 0) })
        .collect())
}

/// An entry for a path found deep in the tree, classified from scratch.
fn loose_entry(c: &Classifier, p: PathBuf, is_dir: bool, size: u64, items: usize) -> Entry {
    let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let cls = c.classify(&p, is_dir);
    Entry {
        collapsed: is_dir && items == 0 && classify::is_bundle(&name),
        name,
        path: p.to_string_lossy().into_owned(),
        size,
        is_dir,
        items,
        category: cls.category,
        safety: cls.safety,
        modified: None,
        delta: None,
        removed: false,
    }
}

/// Max items in the cleanup list; the totals still count everything.
const CLEANUP_LIMIT: usize = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Total<K> {
    pub key: K,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub path: String,
    /// Largest first.
    pub categories: Vec<Total<Category>>,
    pub safety: Vec<Total<Safety>>,
    /// Safe items, largest first, at most `CLEANUP_LIMIT`.
    pub cleanup: Vec<Entry>,
    pub cleanup_count: usize,
    pub cleanup_size: u64,
}

fn totals<K: Copy>(map: std::collections::HashMap<K, u64>) -> Vec<Total<K>> {
    let mut v: Vec<Total<K>> = map.into_iter().map(|(key, size)| Total { key, size }).collect();
    v.sort_unstable_by_key(|t| Reverse(t.size));
    v
}

/// Sizes by category and safety under `path`, and the safe-to-clean items in it.
#[tauri::command]
pub async fn scan_summary(path: String, app: AppHandle) -> Result<Summary, String> {
    blocking(move || {
        let dir = PathBuf::from(&path);
        let c = Classifier::from_env();
        let mut tally = Tally::default();
        app.state::<AppState>().with_node(&dir, |node| c.summarize(node, &dir, c.parent_class(&dir), &mut tally))?;

        let mut safe = tally.safe;
        safe.sort_unstable_by_key(|s| Reverse(s.2));
        let cleanup_count = safe.len();
        let cleanup_size = safe.iter().map(|s| s.2).sum();
        safe.truncate(CLEANUP_LIMIT);
        Ok(Summary {
            path,
            categories: totals(tally.categories),
            safety: totals(tally.safety),
            cleanup: safe.into_iter().map(|(p, is_dir, size, items)| loose_entry(&c, p, is_dir, size, items)).collect(),
            cleanup_count,
            cleanup_size,
        })
    })
    .await?
}

/// Keeps the `limit` largest files in a min-heap.
fn collect_largest(
    node: &Node,
    path: &Path,
    limit: usize,
    keep: &dyn Fn(&Node) -> bool,
    heap: &mut BinaryHeap<Reverse<(u64, PathBuf, u32)>>,
) {
    for c in &node.children {
        if c.is_dir {
            collect_largest(c, &path.join(&c.name), limit, keep, heap);
        } else if keep(c) && (heap.len() < limit || heap.peek().is_some_and(|Reverse((min, _, _))| c.size > *min)) {
            if heap.len() == limit {
                heap.pop();
            }
            heap.push(Reverse((c.size, path.join(&c.name), c.modified)));
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn n(name: &str, size: u64, children: Vec<Node>) -> Node {
        Node { name: name.into(), size, is_dir: !children.is_empty() || name.ends_with('/'), modified: 0, children }
    }

    #[test]
    fn changes_point_at_what_grew() {
        const MB: u64 = 1_000_000;
        let old = n("/", 300 * MB, vec![
            n("a", 200 * MB, vec![n("x", 150 * MB, vec![]), n("y", 50 * MB, vec![])]),
            n("gone", 60 * MB, vec![]),
            n("tiny", 5 * MB, vec![]),
        ]);
        let cur = n("/", 500 * MB, vec![
            // x grew by 100 MB, which explains all of a's growth: report x, not a.
            n("a", 300 * MB, vec![n("x", 250 * MB, vec![]), n("y", 50 * MB, vec![])]),
            n("new", 40 * MB, vec![]),
            n("tiny", 8 * MB, vec![]),
        ]);
        let mut out = Vec::new();
        collect_changes(&cur, &old, Path::new("/"), &mut out);
        let mut got: Vec<(String, i64, bool)> =
            out.iter().map(|c| (c.path.to_string_lossy().into_owned(), c.delta, c.now.is_none())).collect();
        got.sort();
        assert_eq!(got, [
            ("/a/x".into(), 100 * MB as i64, false),
            ("/gone".into(), -60 * MB as i64, true),
            ("/new".into(), 40 * MB as i64, false),
        ]);
    }

    #[test]
    fn pruning_keeps_only_large_items() {
        let t = n("/", 30, vec![n("big", 20, vec![n("f", 15, vec![]), n("g", 5, vec![])]), n("small", 10, vec![])]);
        let p = t.pruned(15);
        assert_eq!(p.children.len(), 1);
        assert_eq!(p.children[0].children.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["f"]);
    }
}
