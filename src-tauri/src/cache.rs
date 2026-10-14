//! Persists scan results so reopening the app shows the last scan instantly.
//! Each scanned root gets `<key>.bin` (bincode tree) plus a tiny `<key>.json`
//! sidecar so the welcome screen can list caches without decoding whole trees.

use crate::scanner::Node;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

/// Bump when `Node` / `ScanTree` layout changes; old caches are then ignored.
const VERSION: u32 = 2;

/// How many scans to keep; older ones are dropped on the next save (each can be hundreds of MB).
const MAX_CACHES: usize = 10;

#[derive(Serialize, Deserialize)]
pub struct ScanTree {
    pub root: PathBuf,
    pub scanned_at: u64, // unix seconds
    pub files: u64,
    pub errors: u64,
    pub node: Node,
    /// The scan before this one, pruned, so the UI can show what grew or shrank.
    pub prev: Option<Prev>,
}

#[derive(Serialize, Deserialize)]
pub struct Prev {
    pub scanned_at: u64,
    pub node: Node,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanMeta {
    pub root: String,
    pub size: u64,
    pub files: u64,
    pub errors: u64,
    pub scanned_at: u64,
    pub elapsed_ms: u64,
    /// Size of the cache file on disk; filled in by `list`.
    #[serde(default)]
    pub cache_bytes: u64,
    /// When the scan this one is compared against ran, if there is one.
    #[serde(default)]
    pub prev_scanned_at: Option<u64>,
}

impl ScanTree {
    pub fn meta(&self, elapsed_ms: u64) -> ScanMeta {
        ScanMeta {
            root: self.root.to_string_lossy().into_owned(),
            size: self.node.size,
            files: self.files,
            errors: self.errors,
            scanned_at: self.scanned_at,
            elapsed_ms,
            cache_bytes: 0,
            prev_scanned_at: self.prev.as_ref().map(|p| p.scanned_at),
        }
    }
}

fn key(root: &Path) -> String {
    root.to_string_lossy().replace('/', "_")
}

/// Serializes the tree to memory. Kept separate from `write` so callers can
/// release the state lock before touching the disk.
pub fn encode(tree: &ScanTree) -> Result<Vec<u8>, String> {
    bincode::serialize(&(VERSION, tree)).map_err(|e| e.to_string())
}

pub fn write(dir: &Path, meta: &ScanMeta, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = dir.join(key(Path::new(&meta.root)));
    // Write-then-rename so a crash never leaves a half-written cache.
    let tmp = base.with_extension("bin.tmp");
    let mut w = BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
    w.write_all(bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    drop(w);
    fs::rename(&tmp, base.with_extension("bin")).map_err(|e| e.to_string())?;
    fs::write(base.with_extension("json"), serde_json::to_vec(meta).unwrap()).map_err(|e| e.to_string())?;
    prune(dir, Path::new(&meta.root));
    Ok(())
}

/// Forgets every scan. Returns the bytes freed.
pub fn clear(dir: &Path) -> u64 {
    list(dir)
        .into_iter()
        .map(|m| {
            remove(dir, Path::new(&m.root));
            m.cache_bytes
        })
        .sum()
}

/// Drops the oldest scans beyond `MAX_CACHES`, never the one just saved.
fn prune(dir: &Path, keep: &Path) {
    for old in list(dir).into_iter().skip(MAX_CACHES) {
        if Path::new(&old.root) != keep {
            remove(dir, Path::new(&old.root));
        }
    }
}

pub fn load(dir: &Path, root: &Path) -> Option<ScanTree> {
    let file = File::open(dir.join(key(root)).with_extension("bin")).ok()?;
    let (version, tree): (u32, ScanTree) = bincode::deserialize_from(BufReader::new(file)).ok()?;
    (version == VERSION).then_some(tree)
}

/// The tree of a cached scan, also from the previous cache format, for comparing with a new scan.
pub fn load_node(dir: &Path, root: &Path) -> Option<(u64, Node)> {
    let bytes = fs::read(dir.join(key(root)).with_extension("bin")).ok()?;
    match bincode::deserialize::<u32>(&bytes).ok()? {
        VERSION => bincode::deserialize::<(u32, ScanTree)>(&bytes).ok().map(|(_, t)| (t.scanned_at, t.node)),
        1 => bincode::deserialize::<(u32, v1::ScanTree)>(&bytes).ok().map(|(_, t)| (t.scanned_at, t.node.into())),
        _ => None,
    }
}

/// Version 1 had no `modified` and no `prev`.
mod v1 {
    use serde::Deserialize;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    pub struct Node {
        name: String,
        size: u64,
        is_dir: bool,
        children: Vec<Node>,
    }

    #[derive(Deserialize)]
    pub struct ScanTree {
        pub _root: PathBuf,
        pub scanned_at: u64,
        pub _files: u64,
        pub _errors: u64,
        pub node: Node,
    }

    impl From<Node> for super::Node {
        fn from(n: Node) -> Self {
            Self { name: n.name, size: n.size, is_dir: n.is_dir, modified: 0, children: n.children.into_iter().map(Into::into).collect() }
        }
    }
}

pub fn list(dir: &Path) -> Vec<ScanMeta> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut metas: Vec<ScanMeta> = rd
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let mut meta: ScanMeta = serde_json::from_slice(&fs::read(e.path()).ok()?).ok()?;
            meta.cache_bytes = fs::metadata(e.path().with_extension("bin")).map_or(0, |m| m.len());
            Some(meta)
        })
        .collect();
    metas.sort_by_key(|m| std::cmp::Reverse(m.scanned_at));
    metas
}

pub fn remove(dir: &Path, root: &Path) {
    let base = dir.join(key(root));
    let _ = fs::remove_file(base.with_extension("bin"));
    let _ = fs::remove_file(base.with_extension("json"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(root: &str, scanned_at: u64) -> ScanMeta {
        ScanMeta { root: root.into(), size: 0, files: 0, errors: 0, scanned_at, elapsed_ms: 0, cache_bytes: 0, prev_scanned_at: None }
    }

    #[test]
    fn keeps_only_the_newest_scans() {
        let dir = std::env::temp_dir().join(format!("disklens-cache-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for i in 0..MAX_CACHES as u64 + 3 {
            write(&dir, &meta(&format!("/scan{i}"), 100 + i), b"x").unwrap();
        }
        let roots: Vec<String> = list(&dir).into_iter().map(|m| m.root).collect();
        assert_eq!(roots.len(), MAX_CACHES);
        assert_eq!(roots[0], format!("/scan{}", MAX_CACHES + 2));
        assert!(!roots.contains(&"/scan0".to_string()));
        assert!(!dir.join(key(Path::new("/scan0"))).with_extension("bin").exists());
        assert!(list(&dir).iter().all(|m| m.cache_bytes == 1));
        assert_eq!(clear(&dir), MAX_CACHES as u64);
        assert!(list(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
