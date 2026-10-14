//! Walks the chosen folders looking for project artifacts. It never descends into a match
//! (a `node_modules` inside another one isn't counted twice) nor into skipped folders.

use super::rules::{wildcard, Rule};
use super::Progress;
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// What a folder matched: an artifact rule, or a `CACHEDIR.TAG` cache.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Match {
    Rule(usize),
    CacheDir,
}

#[derive(Debug)]
pub struct Found {
    pub path: PathBuf,
    pub what: Match,
    /// The folder whose markers matched (the artifact's parent, or deeper for `a/b` dirs).
    pub base: PathBuf,
}

pub struct Walker<'a> {
    /// Artifact rules only, paired with their index in the catalog.
    pub rules: Vec<(usize, &'a Rule)>,
    pub skip_names: &'a HashSet<String>,
    pub skip_paths: HashSet<PathBuf>,
    pub max_depth: usize,
    pub cancel: &'a AtomicBool,
    pub progress: &'a Progress,
    found: Mutex<Vec<Found>>,
    worktrees: Mutex<Vec<PathBuf>>,
    claimed: Mutex<HashSet<PathBuf>>,
}

pub struct WalkOut {
    pub found: Vec<Found>,
    /// Folders whose `.git` is a file: linked worktrees (or submodules).
    pub git_files: Vec<PathBuf>,
}

impl<'a> Walker<'a> {
    pub fn new(
        rules: Vec<(usize, &'a Rule)>,
        skip_names: &'a HashSet<String>,
        skip_paths: HashSet<PathBuf>,
        max_depth: usize,
        cancel: &'a AtomicBool,
        progress: &'a Progress,
    ) -> Self {
        Self {
            rules,
            skip_names,
            skip_paths,
            max_depth,
            cancel,
            progress,
            found: Mutex::new(Vec::new()),
            worktrees: Mutex::new(Vec::new()),
            claimed: Mutex::new(HashSet::new()),
        }
    }

    pub fn run(self, roots: &[PathBuf]) -> WalkOut {
        roots.par_iter().for_each(|r| self.visit(r, 0));
        WalkOut { found: self.found.into_inner().unwrap(), git_files: self.worktrees.into_inner().unwrap() }
    }

    fn claim(&self, path: PathBuf, what: Match, base: &Path) {
        if self.claimed.lock().unwrap().insert(path.clone()) {
            self.progress.found.fetch_add(1, Ordering::Relaxed);
            self.found.lock().unwrap().push(Found { path, what, base: base.to_path_buf() });
        }
    }

    fn visit(&self, dir: &Path, depth: usize) {
        if self.cancel.load(Ordering::Relaxed) || depth > self.max_depth {
            return;
        }
        let Ok(read) = fs::read_dir(dir) else { return };
        let entries: Vec<(String, fs::FileType)> = read
            .flatten()
            .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), e.file_type().ok()?)))
            .collect();
        self.progress.dirs.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut cur) = self.progress.current.try_lock() {
            *cur = dir.to_string_lossy().into_owned();
        }
        let names: HashSet<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();

        // https://bford.info/cachedir/ — the folder says about itself that it is a cache.
        if depth > 0 && names.contains("CACHEDIR.TAG") {
            if let Some(parent) = dir.parent() {
                self.claim(dir.to_path_buf(), Match::CacheDir, parent);
            }
            return;
        }
        if entries.iter().any(|(n, t)| n == ".git" && t.is_file()) {
            self.worktrees.lock().unwrap().push(dir.to_path_buf());
        }

        for &(idx, rule) in &self.rules {
            if !rule.markers.is_empty() && !rule.markers.iter().any(|m| names.iter().any(|n| wildcard(m, n))) {
                continue;
            }
            for d in &rule.dirs {
                let first = d.split('/').next().unwrap_or(d);
                if !names.contains(first) {
                    continue;
                }
                let path = dir.join(d);
                let is_dir = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
                if is_dir && (rule.inside.is_empty() || rule.inside.iter().any(|f| path.join(f).exists())) {
                    self.claim(path, Match::Rule(idx), dir);
                }
            }
        }

        let subdirs: Vec<PathBuf> = {
            let claimed = self.claimed.lock().unwrap();
            entries
                .iter()
                .filter(|(n, t)| t.is_dir() && !self.skip_names.contains(n))
                .map(|(n, _)| dir.join(n))
                .filter(|p| !claimed.contains(p) && !self.skip_paths.contains(p))
                .collect()
        };
        subdirs.par_iter().for_each(|d| self.visit(d, depth + 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::rules::load;

    #[test]
    fn finds_artifacts_and_prunes() {
        let tmp = std::env::temp_dir().join(format!("disklens-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let mk = |p: &str| fs::create_dir_all(tmp.join(p)).unwrap();
        let touch = |p: &str| fs::write(tmp.join(p), "").unwrap();
        mk("web/node_modules/dep/node_modules");
        touch("web/package.json");
        touch("web/node_modules/dep/package.json");
        mk("loose/node_modules"); // no package.json: not a project
        mk("crate/target/debug");
        touch("crate/Cargo.toml");
        mk("py/.venv");
        touch("py/.venv/pyvenv.cfg");
        mk("py/venv"); // no pyvenv.cfg
        mk("lara/storage/framework/cache");
        touch("lara/artisan");
        mk("misc/thing");
        touch("misc/thing/CACHEDIR.TAG");
        mk("wt");
        touch("wt/.git");

        let cat = load(None);
        let rules = cat.rules.iter().enumerate().filter(|(_, r)| r.kind == crate::dev::rules::Kind::Artifact).collect();
        let cancel = AtomicBool::new(false);
        let progress = Progress::default();
        let out = Walker::new(rules, &cat.walk.skip_names, HashSet::new(), 10, &cancel, &progress).run(std::slice::from_ref(&tmp));
        let mut got: Vec<String> = out
            .found
            .iter()
            .map(|f| f.path.strip_prefix(&tmp).unwrap().to_string_lossy().into_owned())
            .collect();
        got.sort();
        assert_eq!(got, ["crate/target", "lara/storage/framework/cache", "misc/thing", "py/.venv", "web/node_modules"]);
        assert_eq!(out.git_files, [tmp.join("wt")]);
        fs::remove_dir_all(&tmp).unwrap();
    }
}
