//! Developer cleanup: build artifacts, package caches, old SDK versions and AI-tool data
//! that can be regenerated. What counts is decided by the rules in `rules`.

pub mod git;
pub mod rules;
mod walk;

use crate::scanner::{scan_root, ScanCtx};
use rayon::prelude::*;
use rules::{expand, version_cmp, version_group, Catalog, Category, Kind, Rule, Safety, Warning};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};
use walk::{Match, Walker};

#[derive(Default)]
pub struct Progress {
    phase: AtomicU8,
    pub dirs: AtomicU64,
    pub found: AtomicU64,
    measured: AtomicU64,
    total: AtomicU64,
    bytes: AtomicU64,
    pub current: Mutex<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: &'static str,
    pub dirs: u64,
    pub found: u64,
    pub measured: u64,
    pub total: u64,
    pub bytes: u64,
    pub current: String,
}

const PHASES: [&str; 4] = ["locations", "walk", "git", "measure"];

impl Progress {
    fn phase(&self, i: u8) {
        self.phase.store(i, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> ProgressEvent {
        ProgressEvent {
            phase: PHASES[self.phase.load(Ordering::Relaxed) as usize],
            dirs: self.dirs.load(Ordering::Relaxed),
            found: self.found.load(Ordering::Relaxed),
            measured: self.measured.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            current: self.current.lock().unwrap().clone(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevItem {
    pub path: String,
    pub name: String,
    pub rule_id: String,
    pub label: String,
    pub eco: String,
    pub category: Category,
    pub safety: Safety,
    pub restore: Option<String>,
    pub description: Option<String>,
    pub size: u64,
    /// Unix seconds; the folder's own mtime.
    pub mtime: u64,
    /// From the user's rules file rather than the built-in catalog.
    pub custom: bool,
    /// A user rule pointing outside the home folder: listed, never deletable.
    pub view_only: bool,
    /// Apps that use this folder and are open right now; quit them before deleting.
    pub running: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeKind {
    Git,
    Claude,
    Codex,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub kind: WorktreeKind,
    /// The main repository, where `git worktree prune` runs after deleting.
    pub main: Option<String>,
    /// The whole checkout.
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevProject {
    pub path: String,
    pub name: String,
    pub ecos: Vec<String>,
    /// Unix seconds: latest of the git index, HEAD log and manifest files.
    pub last_active: u64,
    pub worktree: Option<Worktree>,
    pub items: Vec<DevItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RulesInfo {
    pub path: String,
    /// The rules file's mtime (ms) when it was read; lets the UI notice later edits.
    pub mtime: Option<u64>,
    pub builtin: usize,
    pub custom: usize,
    pub disabled: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DevReport {
    pub projects: Vec<DevProject>,
    /// Everything outside projects: caches, SDKs, IDE and AI data, old versions.
    pub items: Vec<DevItem>,
    pub warnings: Vec<Warning>,
    pub rules: RulesInfo,
    pub elapsed_ms: u64,
    /// Unix seconds; lets a cached report show its age.
    pub scanned_at: u64,
}

fn mtime(p: &Path) -> u64 {
    fs::symlink_metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

fn name_of(p: &Path) -> String {
    p.file_name().map_or_else(|| p.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// Names of running apps (`Foo` for `/Applications/Foo.app/…`) and plain executables.
fn running_apps() -> HashSet<String> {
    let Ok(out) = Command::new("ps").args(["-A", "-o", "comm="]).output() else { return HashSet::new() };
    let mut names = HashSet::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(i) = line.find(".app/") {
            names.insert(line[..i].rsplit('/').next().unwrap_or_default().to_string());
        }
        names.insert(line.rsplit('/').next().unwrap_or_default().to_string());
    }
    names
}

/// Allocated bytes, like the main scanner (files are measured directly).
fn measure(path: &Path, cancel: &Arc<AtomicBool>) -> u64 {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => {
            let ctx = ScanCtx::new(path, cancel.clone());
            scan_root(path, &ctx, &|_| {}).map_or(0, |n| n.size)
        }
        Ok(m) => m.blocks() * 512,
        Err(_) => 0,
    }
}

struct Builder<'a> {
    home: &'a Path,
    running: HashSet<String>,
}

impl Builder<'_> {
    fn item(&self, rule: &Rule, path: &Path, label: Option<String>, safety: Safety, description: Option<String>) -> DevItem {
        let category = rule.category();
        DevItem {
            path: path.to_string_lossy().into_owned(),
            name: name_of(path),
            rule_id: rule.id.clone(),
            label: label.or_else(|| rule.label.clone()).unwrap_or_else(|| name_of(path)),
            eco: rule.eco.clone(),
            category,
            safety,
            restore: rule.restore.clone(),
            description: description.or_else(|| rule.description.clone()),
            size: 0,
            mtime: mtime(path),
            custom: rule.custom,
            view_only: rule.custom && category != Category::Project && !path.starts_with(self.home),
            running: rule.apps.iter().filter(|a| self.running.contains(*a)).cloned().collect(),
        }
    }

    /// Items at fixed paths. Versioned rules go first so a "current version" location
    /// rule can't swallow the old copies listed separately.
    fn fixed(&self, cat: &Catalog) -> Vec<DevItem> {
        let mut out = Vec::new();
        let by_kind = |k: Kind| cat.rules.iter().filter(move |r| r.kind == k);
        for rule in by_kind(Kind::Versioned) {
            let mut groups: HashMap<(PathBuf, String), Vec<PathBuf>> = HashMap::new();
            for p in rule.paths.iter().flat_map(|p| expand(p, self.home)) {
                let name = name_of(&p);
                if name.chars().any(|c| c.is_ascii_digit()) {
                    let parent = p.parent().map(Path::to_path_buf).unwrap_or_default();
                    groups.entry((parent, version_group(&name))).or_default().push(p);
                }
            }
            for mut list in groups.into_values() {
                list.sort_by(|a, b| version_cmp(&name_of(b), &name_of(a)));
                list.dedup();
                for old in list.iter().skip(rule.keep) {
                    let label = Some(format!("{} {}", rule.label.as_deref().unwrap_or_default(), name_of(old)).trim().to_string());
                    out.push(self.item(rule, old, label, rule.safety(), None));
                }
            }
        }
        for rule in by_kind(Kind::Location) {
            for p in rule.paths.iter().flat_map(|p| expand(p, self.home)) {
                out.push(self.item(rule, &p, None, rule.safety(), None));
            }
        }
        for rule in by_kind(Kind::Template) {
            let entries = rule.template.as_ref().and_then(|t| cat.templates.get(t)).map_or(&[][..], Vec::as_slice);
            for base in rule.paths.iter().flat_map(|p| expand(p, self.home)) {
                for e in entries {
                    let p = base.join(&e.path);
                    if fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                        let what = e.label.clone().unwrap_or_else(|| e.path.clone());
                        let label = Some(format!("{} · {what}", rule.label.as_deref().unwrap_or(&name_of(&base))));
                        out.push(self.item(rule, &p, label, e.safety, e.description.clone()));
                    }
                }
            }
        }
        dedup_nested(out)
    }
}

/// Drops duplicates (several rules or `$VAR` aliases reaching the same folder) and items
/// inside another item, which would otherwise be counted twice.
fn dedup_nested(items: Vec<DevItem>) -> Vec<DevItem> {
    let key = |i: &DevItem| fs::canonicalize(&i.path).unwrap_or_else(|_| PathBuf::from(&i.path));
    let mut seen = HashSet::new();
    let items: Vec<(PathBuf, DevItem)> = items.into_iter().map(|i| (key(&i), i)).filter(|(k, _)| seen.insert(k.clone())).collect();
    items
        .into_iter()
        .filter(|(k, _)| !k.ancestors().skip(1).any(|a| seen.contains(a)))
        .map(|(_, i)| i)
        .collect()
}

/// The project an artifact belongs to: the nearest folder with `.git` at or above `base`,
/// without leaving the scanned folder. Falls back to `base` itself.
fn project_root(base: &Path, roots: &[PathBuf], cache: &mut HashMap<PathBuf, Option<PathBuf>>) -> PathBuf {
    let top = roots.iter().filter(|r| base.starts_with(r)).max_by_key(|r| r.as_os_str().len());
    for dir in base.ancestors() {
        let hit = cache.entry(dir.to_path_buf()).or_insert_with(|| dir.join(".git").exists().then(|| dir.to_path_buf()));
        if let Some(root) = hit {
            return root.clone();
        }
        if Some(&dir.to_path_buf()) == top {
            break;
        }
    }
    base.to_path_buf()
}

fn worktree_kind(dir: &Path, home: &Path) -> WorktreeKind {
    let s = dir.to_string_lossy();
    if s.contains("/.claude/worktrees/") {
        WorktreeKind::Claude
    } else if s.contains("/.codex/worktrees/") || dir.starts_with(home.join(".codex")) {
        WorktreeKind::Codex
    } else {
        WorktreeKind::Git
    }
}

pub struct ScanInput<'a> {
    pub folders: &'a [PathBuf],
    pub catalog: &'a Catalog,
    pub rules_path: &'a Path,
    pub rules_mtime: Option<u64>,
    pub home: &'a Path,
    pub cancel: &'a Arc<AtomicBool>,
    pub progress: &'a Progress,
}

/// Runs a whole scan inside the current rayon pool. `None` if cancelled.
pub fn scan(input: ScanInput) -> Option<DevReport> {
    let ScanInput { folders, catalog: cat, rules_path, rules_mtime, home, cancel, progress } = input;
    let started = Instant::now();
    let builder = Builder { home, running: running_apps() };

    progress.phase(0);
    let mut fixed = builder.fixed(cat);

    progress.phase(1);
    let mut roots: Vec<PathBuf> = folders.iter().filter(|f| f.is_dir()).cloned().collect();
    roots.sort();
    roots.dedup();
    let all = roots.clone();
    roots.retain(|r| !all.iter().any(|o| o != r && r.starts_with(o)));
    // Codex keeps its worktrees under ~/.codex, which the walk otherwise skips.
    let codex = home.join(".codex/worktrees");
    if codex.is_dir() && roots.iter().any(|r| codex.starts_with(r)) {
        roots.push(codex);
    }
    let mut skip: HashSet<PathBuf> = cat.walk.skip_paths.iter().flat_map(|p| expand(p, home)).collect();
    skip.extend(fixed.iter().map(|i| PathBuf::from(&i.path)));
    let artifact_rules = cat.rules.iter().enumerate().filter(|(_, r)| r.kind == Kind::Artifact).collect();
    let walked = Walker::new(artifact_rules, &cat.walk.skip_names, skip, cat.walk.max_depth, cancel, progress).run(&roots);
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    // Each found artifact, tagged with its project.
    let mut root_cache = HashMap::new();
    let cachedir = Rule {
        id: "cachedir".into(),
        kind: Kind::Artifact,
        eco: "other".into(),
        category: None,
        label: Some("CACHEDIR.TAG".into()),
        description: None,
        safety: Some(Safety::Safe),
        restore: None,
        disabled: false,
        dirs: Vec::new(),
        markers: Vec::new(),
        inside: Vec::new(),
        git_ignored: false,
        paths: Vec::new(),
        template: None,
        apps: Vec::new(),
        keep: 1,
        custom: false,
    };
    let mut found: Vec<(PathBuf, &Rule, PathBuf, DevItem)> = walked
        .found
        .iter()
        .map(|f| {
            let rule = match f.what {
                Match::Rule(i) => &cat.rules[i],
                Match::CacheDir => &cachedir,
            };
            let root = project_root(&f.base, &roots, &mut root_cache);
            let item = builder.item(rule, &f.path, None, rule.safety(), None);
            (root, rule, f.base.clone(), item)
        })
        .collect();

    // Generic names (vendor, build, bin…) only count when git ignores them; otherwise
    // they may be checked-in source.
    progress.phase(2);
    let mut check: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for (root, rule, _, item) in &found {
        if rule.git_ignored && Path::new(root).join(".git").exists() {
            check.entry(root.clone()).or_default().push(PathBuf::from(&item.path));
        }
    }
    let verdicts: HashMap<PathBuf, Option<HashSet<PathBuf>>> =
        check.into_par_iter().map(|(root, paths)| (root.clone(), git::ignored(&root, &paths))).collect();
    found.retain_mut(|(root, rule, _, item)| {
        if !rule.git_ignored {
            return true;
        }
        match verdicts.get(root) {
            Some(Some(ignored)) => ignored.contains(Path::new(&item.path)),
            Some(None) => {
                item.safety = Safety::Caution;
                true
            }
            None => true,
        }
    });

    // Linked worktrees, measured whole.
    let worktrees: Vec<(PathBuf, Option<PathBuf>)> =
        walked.git_files.iter().filter_map(|d| git::worktree_main(d).map(|m| (d.clone(), Some(m)))).collect();

    progress.phase(3);
    let jobs: Vec<PathBuf> = fixed
        .iter()
        .chain(found.iter().map(|f| &f.3))
        .map(|i| PathBuf::from(&i.path))
        .chain(worktrees.iter().map(|w| w.0.clone()))
        .collect();
    progress.total.store(jobs.len() as u64, Ordering::Relaxed);
    let sizes: HashMap<PathBuf, u64> = jobs
        .into_par_iter()
        .map(|p| {
            let size = measure(&p, cancel);
            progress.measured.fetch_add(1, Ordering::Relaxed);
            progress.bytes.fetch_add(size, Ordering::Relaxed);
            (p, size)
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let size_of = |p: &str| sizes.get(Path::new(p)).copied().unwrap_or(0);
    for item in fixed.iter_mut().chain(found.iter_mut().map(|f| &mut f.3)) {
        item.size = size_of(&item.path);
    }

    // Group into projects.
    let mut projects: HashMap<PathBuf, DevProject> = HashMap::new();
    let mut markers: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let new_project = |root: &Path| DevProject {
        path: root.to_string_lossy().into_owned(),
        name: name_of(root),
        ecos: Vec::new(),
        last_active: 0,
        worktree: None,
        items: Vec::new(),
    };
    for (root, rule, base, item) in found {
        if item.size == 0 {
            continue;
        }
        let m = markers.entry(root.clone()).or_default();
        m.extend(rule.markers.iter().filter(|s| !s.contains(['*', '?'])).map(|s| base.join(s)));
        projects.entry(root.clone()).or_insert_with(|| new_project(&root)).items.push(item);
    }
    for (dir, main) in worktrees {
        let size = sizes.get(&dir).copied().unwrap_or(0);
        let kind = worktree_kind(&dir, home);
        let main = main.map(|m| m.to_string_lossy().into_owned());
        projects.entry(dir.clone()).or_insert_with(|| new_project(&dir)).worktree = Some(Worktree { kind, main, size });
    }
    let mut projects: Vec<DevProject> = projects
        .into_iter()
        .map(|(root, mut p)| {
            let git = git::git_dir(&root);
            let mut times: Vec<u64> = git.iter().flat_map(|g| [mtime(&g.join("index")), mtime(&g.join("logs/HEAD"))]).collect();
            times.extend(markers.get(&root).into_iter().flatten().map(|m| mtime(m)));
            p.last_active = times.into_iter().max().filter(|&t| t > 0).unwrap_or_else(|| mtime(&root));
            p.items.sort_by_key(|i| std::cmp::Reverse(i.size));
            let mut ecos: Vec<String> = p.items.iter().map(|i| i.eco.clone()).collect();
            ecos.sort();
            ecos.dedup();
            p.ecos = ecos;
            p
        })
        .collect();
    let total = |p: &DevProject| p.items.iter().map(|i| i.size).sum::<u64>().max(p.worktree.as_ref().map_or(0, |w| w.size));
    projects.sort_by_key(|p| std::cmp::Reverse(total(p)));

    fixed.retain(|i| i.size > 0);
    fixed.sort_by_key(|i| std::cmp::Reverse(i.size));

    Some(DevReport {
        projects,
        items: fixed,
        warnings: cat.warnings.clone(),
        rules: RulesInfo {
            path: rules_path.to_string_lossy().into_owned(),
            mtime: rules_mtime,
            builtin: cat.builtin,
            custom: cat.custom,
            disabled: cat.disabled,
        },
        elapsed_ms: started.elapsed().as_millis() as u64,
        scanned_at: crate::state::now_secs(),
    })
}

// ---------- cache ----------

/// Bumped when `DevReport` changes shape, so an old cache is ignored rather than misread.
const CACHE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Cached {
    version: u32,
    report: DevReport,
}

fn cache_file(dir: &Path) -> PathBuf {
    dir.join("dev-report.cache")
}

/// Saves the last report so the screen opens instantly next time.
pub fn save_report(dir: &Path, report: &DevReport) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(&Cached { version: CACHE_VERSION, report: report.clone() }).map_err(|e| e.to_string())?;
    let file = cache_file(dir);
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The last saved report, minus anything deleted since (sizes may be out of date).
pub fn load_report(dir: &Path) -> Option<DevReport> {
    let cached: Cached = serde_json::from_slice(&fs::read(cache_file(dir)).ok()?).ok()?;
    if cached.version != CACHE_VERSION {
        return None;
    }
    let mut r = cached.report;
    let exists = |p: &str| fs::symlink_metadata(p).is_ok();
    r.items.retain(|i| exists(&i.path));
    r.projects.retain(|p| exists(&p.path));
    for p in &mut r.projects {
        p.items.retain(|i| exists(&i.path));
    }
    r.projects.retain(|p| !p.items.is_empty() || p.worktree.is_some());
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::rules::{Category, Safety};

    fn item(path: &Path) -> DevItem {
        DevItem {
            path: path.to_string_lossy().into_owned(),
            name: "x".into(),
            rule_id: "r".into(),
            label: "x".into(),
            eco: "node".into(),
            category: Category::Project,
            safety: Safety::Safe,
            restore: None,
            description: None,
            size: 1,
            mtime: 0,
            custom: false,
            view_only: false,
            running: Vec::new(),
        }
    }

    #[test]
    fn cached_report_drops_deleted_paths() {
        let tmp = std::env::temp_dir().join(format!("disklens-devcache-{}", std::process::id()));
        let (kept, gone) = (tmp.join("proj/kept"), tmp.join("proj/gone"));
        fs::create_dir_all(&kept).unwrap();
        let report = DevReport {
            projects: vec![DevProject {
                path: tmp.join("proj").to_string_lossy().into_owned(),
                name: "proj".into(),
                ecos: vec!["node".into()],
                last_active: 0,
                worktree: None,
                items: vec![item(&kept), item(&gone)],
            }],
            items: vec![item(&gone)],
            warnings: Vec::new(),
            rules: RulesInfo { path: String::new(), mtime: None, builtin: 0, custom: 0, disabled: 0 },
            elapsed_ms: 0,
            scanned_at: 42,
        };
        let dir = tmp.join("cache");
        save_report(&dir, &report).unwrap();
        let back = load_report(&dir).unwrap();
        assert_eq!(back.scanned_at, 42);
        assert!(back.items.is_empty());
        assert_eq!(back.projects[0].items.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }
}
