use crate::classify;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// In-memory size tree. Children are kept sorted by size, largest first.
#[derive(Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    /// Files only: last modified, unix seconds (0 when unknown). Fits in `Node`'s padding.
    pub modified: u32,
    pub children: Vec<Node>,
}

impl Node {
    pub fn find(&self, rel: &[String]) -> Option<&Node> {
        let mut node = self;
        for name in rel {
            node = node.children.iter().find(|c| &c.name == name)?;
        }
        Some(node)
    }

    /// Removes the descendant at `rel` and subtracts its size from every ancestor.
    pub fn remove(&mut self, rel: &[String]) -> Option<u64> {
        let (first, rest) = rel.split_first()?;
        let idx = self.children.iter().position(|c| &c.name == first)?;
        let removed = if rest.is_empty() {
            self.children.remove(idx).size
        } else {
            let removed = self.children[idx].remove(rest)?;
            sort_by_size(&mut self.children);
            removed
        };
        self.size = self.size.saturating_sub(removed);
        Some(removed)
    }

    /// Swaps in a freshly scanned subtree at `rel` and fixes every ancestor's size.
    pub fn replace(&mut self, rel: &[String], new: Node) -> Option<()> {
        let (first, rest) = rel.split_first()?;
        let idx = self.children.iter().position(|c| &c.name == first)?;
        let old = self.children[idx].size;
        if rest.is_empty() {
            self.children[idx] = new;
        } else {
            self.children[idx].replace(rest, new)?;
        }
        self.size = self.size - old + self.children[idx].size;
        sort_by_size(&mut self.children);
        Some(())
    }
}

impl Node {
    /// A copy without anything smaller than `min`, kept to compare against the next scan.
    /// Sizes stay exact; only small children are dropped.
    pub fn pruned(&self, min: u64) -> Node {
        Node {
            name: self.name.clone(),
            size: self.size,
            is_dir: self.is_dir,
            modified: 0,
            children: self.children.iter().take_while(|c| c.size >= min).map(|c| c.pruned(min)).collect(),
        }
    }
}

fn sort_by_size(nodes: &mut [Node]) {
    nodes.sort_unstable_by_key(|n| std::cmp::Reverse(n.size));
}

pub struct ScanCtx {
    pub cancel: Arc<AtomicBool>,
    pub files: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub current: Mutex<String>,
    /// Top-level folders that are fully sized, so they can be browsed before the scan ends.
    /// Moved back into the root node when the scan finishes.
    pub done: Mutex<Vec<Node>>,
    devices: HashSet<u64>,
    skip: HashSet<PathBuf>,
    inodes: Mutex<HashSet<(u64, u64)>>,
}

impl ScanCtx {
    pub fn new(root: &Path, cancel: Arc<AtomicBool>) -> Self {
        let mut devices = HashSet::new();
        let mut skip = HashSet::new();
        if let Ok(m) = fs::metadata(root) {
            devices.insert(m.dev());
        }
        if root == Path::new("/") {
            let extra = crate::platform::root_scan();
            devices.extend(extra.devices);
            skip.extend(extra.skip);
        }
        Self {
            cancel,
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            current: Mutex::new(String::new()),
            done: Mutex::new(Vec::new()),
            devices,
            skip,
            inodes: Mutex::new(HashSet::new()),
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// True the first time a (dev, inode) pair is seen, so hard links count once.
    fn first_link(&self, dev: u64, ino: u64) -> bool {
        self.inodes.lock().unwrap().insert((dev, ino))
    }
}

/// Scans `root` recursively. `on_child` fires as each top-level directory finishes,
/// so the UI can show partial results while the rest is still sizing.
pub fn scan_root(root: &Path, ctx: &ScanCtx, on_child: &(dyn Fn(&Node) + Sync)) -> Option<Node> {
    let meta = fs::metadata(root).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    let node = scan_dir(root, name, allocated(&meta), ctx, Some(on_child));
    (!ctx.cancelled()).then_some(node)
}

/// Bytes actually allocated on disk (sparse files such as Docker.raw report a huge
/// logical size but use far less).
fn allocated(meta: &fs::Metadata) -> u64 {
    meta.blocks() * 512
}

fn scan_dir(
    path: &Path,
    name: String,
    own_size: u64,
    ctx: &ScanCtx,
    on_child: Option<&(dyn Fn(&Node) + Sync)>,
) -> Node {
    if let Ok(mut cur) = ctx.current.try_lock() {
        *cur = path.display().to_string();
    }
    ctx.bytes.fetch_add(own_size, Ordering::Relaxed);

    let entries: Vec<(PathBuf, String)> = match fs::read_dir(path) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .map(|e| (e.path(), e.file_name().to_string_lossy().into_owned()))
            .collect(),
        Err(_) => {
            ctx.errors.fetch_add(1, Ordering::Relaxed);
            Vec::new()
        }
    };

    let mut children: Vec<Node> = entries
        .into_par_iter()
        .filter_map(|(p, n)| {
            let node = scan_entry(p, n, ctx)?;
            match on_child.filter(|_| node.is_dir) {
                Some(cb) => {
                    // Publish before announcing it, so the UI can open it as soon as it hears about it.
                    let mut done = ctx.done.lock().unwrap();
                    cb(&node);
                    done.push(node);
                    None
                }
                None => Some(node),
            }
        })
        .collect();
    if on_child.is_some() {
        children.append(&mut ctx.done.lock().unwrap());
    }
    sort_by_size(&mut children);

    let size = own_size + children.iter().map(|c| c.size).sum::<u64>();
    Node { name, size, is_dir: true, modified: 0, children }
}

fn scan_entry(path: PathBuf, name: String, ctx: &ScanCtx) -> Option<Node> {
    if ctx.cancelled() {
        return None;
    }
    // lstat: never follow symlinks.
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            ctx.errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };

    if meta.is_dir() {
        if !ctx.devices.contains(&meta.dev()) || ctx.skip.contains(&path) {
            return None;
        }
        let mut node = scan_dir(&path, name, allocated(&meta), ctx, None);
        if classify::is_bundle(&node.name) {
            // Sized in full, but the contents aren't kept; opening the bundle rescans it.
            node.children = Vec::new();
        }
        return Some(node);
    }

    let size = if meta.nlink() > 1 && !ctx.first_link(meta.dev(), meta.ino()) {
        0
    } else {
        allocated(&meta)
    };
    ctx.files.fetch_add(1, Ordering::Relaxed);
    ctx.bytes.fetch_add(size, Ordering::Relaxed);
    let modified = u32::try_from(meta.mtime()).unwrap_or(0);
    Some(Node { name, size, is_dir: false, modified, children: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_dedupes_hard_links_and_removes() {
        let dir = std::env::temp_dir().join(format!("cmd-scan-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("a/b")).unwrap();
        fs::write(dir.join("a/b/big.bin"), vec![1u8; 200_000]).unwrap();
        fs::write(dir.join("small.txt"), b"hi").unwrap();
        fs::hard_link(dir.join("a/b/big.bin"), dir.join("link.bin")).unwrap();
        fs::create_dir_all(dir.join("Foo.app/Contents")).unwrap();
        fs::write(dir.join("Foo.app/Contents/bin"), vec![1u8; 50_000]).unwrap();
        std::os::unix::fs::symlink("/usr", dir.join("sym")).unwrap();

        let ctx = ScanCtx::new(&dir, Arc::new(AtomicBool::new(false)));
        let announced = Mutex::new(Vec::new());
        let mut root = scan_root(&dir, &ctx, &|n| announced.lock().unwrap().push(n.name.clone())).unwrap();
        let mut announced = announced.into_inner().unwrap();
        announced.sort();
        assert_eq!(announced, ["Foo.app", "a"], "only top-level folders are announced");
        let app = root.find(&["Foo.app".into()]).unwrap();
        assert!(app.size >= 50_000 && app.children.is_empty(), "bundle sized but not kept");
        assert!(ctx.done.lock().unwrap().is_empty(), "finished folders moved back into the tree");

        let big = root.find(&["a".into(), "b".into(), "big.bin".into()]).unwrap().size;
        let link = root.find(&["link.bin".into()]).unwrap().size;
        assert!(big + link >= 200_000 && big.min(link) == 0, "hard link counted once");
        assert!(root.size < 400_000, "symlink to /usr not followed");
        assert_eq!(root.children[0].size.max(root.children[1].size), root.children[0].size, "sorted desc");

        let before = root.size;
        let a = root.find(&["a".into()]).unwrap().size;
        root.remove(&["a".into()]).unwrap();
        assert_eq!(root.size, before - a);
        fs::remove_dir_all(&dir).unwrap();
    }
}
