//! Small `git` helpers. Where git is looked for depends on the OS (`platform::GIT_CANDIDATES`).

use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

fn git_bin() -> Option<&'static Path> {
    static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();
    BIN.get_or_init(|| {
        crate::platform::GIT_CANDIDATES.iter().map(PathBuf::from).find(|p| p.is_file())
    })
    .as_deref()
}

fn git(dir: &Path) -> Option<Command> {
    let mut cmd = Command::new(git_bin()?);
    cmd.arg("-C").arg(dir).stderr(Stdio::null());
    Some(cmd)
}

fn output(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git(dir)?.args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Which of `paths` git ignores in the repo at `repo`. `None` when git can't tell
/// (not installed, not a repo, unsafe ownership…).
pub fn ignored(repo: &Path, paths: &[PathBuf]) -> Option<HashSet<PathBuf>> {
    let mut child = git(repo)?
        .args(["check-ignore", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    {
        let mut stdin = child.stdin.take()?;
        for p in paths {
            // The trailing slash lets directory patterns such as `vendor/` match.
            let _ = writeln!(stdin, "{}/", p.display());
        }
    }
    let out = child.wait_with_output().ok()?;
    // 0: some ignored, 1: none ignored, anything else is an error.
    if !matches!(out.status.code(), Some(0 | 1)) {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| PathBuf::from(l.trim_end_matches('/')))
            .collect(),
    )
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    /// Files with uncommitted changes, untracked ones included.
    pub dirty: u32,
    /// Commits not on any remote; `None` when the repo has no remote.
    pub unpushed: Option<u32>,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
}

pub fn worktree_status(dir: &Path) -> Result<WorktreeStatus, String> {
    let status = output(dir, &["status", "--porcelain"]).ok_or("git status failed")?;
    let has_remote = output(dir, &["remote"]).is_some_and(|r| !r.trim().is_empty());
    let unpushed = if has_remote {
        output(dir, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).and_then(|s| s.trim().parse().ok())
    } else {
        None
    };
    let branch = output(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(WorktreeStatus { dirty: status.lines().count() as u32, unpushed, branch })
}

/// Drops worktree records whose folder is gone.
pub fn prune_worktrees(repo: &Path) {
    if let Some(mut cmd) = git(repo) {
        let _ = cmd.args(["worktree", "prune"]).status();
    }
}

/// For a linked worktree, the main repository: `.git` holds `gitdir: <repo>/.git/worktrees/<name>`.
/// Submodules (`.git/modules/…`) aren't worktrees.
pub fn worktree_main(dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dir.join(".git")).ok()?;
    let gitdir = text.trim().strip_prefix("gitdir:")?.trim();
    let gitdir = dir.join(gitdir);
    let worktrees = gitdir.parent()?;
    (worktrees.file_name()? == "worktrees").then(|| worktrees.parent()?.parent().map(Path::to_path_buf))?
}

/// Where git keeps this checkout's index: `.git/` or, for a worktree, the gitdir it points to.
pub fn git_dir(dir: &Path) -> Option<PathBuf> {
    let dot = dir.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    Some(dir.join(text.trim().strip_prefix("gitdir:")?.trim()))
}
