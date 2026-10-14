//! Opt-in usage stats, crash logs and issue reports.
//!
//! - **Usage stats** (`app_open` only) go to Aptabase, and only after the user agreed. Without an
//!   `APTABASE_APP_KEY` at build time (forks, dev builds) nothing is ever sent.
//! - **Crash logs** are always written to disk, never sent. The user reads them and decides
//!   whether to attach one to an issue.
//! - Everything that leaves the machine or lands in a log has the home folder and user names
//!   scrubbed (`scrub`).

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::OnceLock;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ISSUES_URL: &str = "https://github.com/nhamhv/DiskLens/issues/new";
const APP_KEY: Option<&str> = option_env!("APTABASE_APP_KEY");
const APP_HOST: Option<&str> = option_env!("APTABASE_HOST");
const MAX_CRASH_LOGS: usize = 20;
const MAX_UI_ERRORS: usize = 5;
const MAX_LOG_BYTES: usize = 32 * 1024;
const MAX_URL_LEN: usize = 6000;

static DIR: OnceLock<PathBuf> = OnceLock::new();
/// 0 = not asked yet, 1 = agreed, 2 = declined.
static CONSENT: AtomicU8 = AtomicU8::new(0);
static UI_ERRORS: AtomicUsize = AtomicUsize::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    /// This build has an Aptabase key; without one the UI doesn't ask.
    pub available: bool,
    pub consent: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashLog {
    pub name: String,
    pub modified: u64,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReport {
    /// The text shown to the user; the same text goes into the issue.
    pub body: String,
    pub url: String,
}

/// Call once from `setup`: remembers where logs live, loads the saved choice, starts crash
/// logging and, if the user agreed, counts this launch.
pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(crash_dir_in(&dir));
    let _ = DIR.set(dir);
    CONSENT.store(read_consent(), Ordering::Relaxed);
    install_panic_hook();
    track_open();
}

fn data_dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

fn crash_dir_in(dir: &Path) -> PathBuf {
    dir.join("crashes")
}

pub fn crash_dir() -> Option<PathBuf> {
    data_dir().map(crash_dir_in)
}

// ---------- consent ----------

fn consent_file() -> Option<PathBuf> {
    data_dir().map(|d| d.join("telemetry.json"))
}

fn read_consent() -> u8 {
    let text = consent_file().and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    match serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["consent"].as_bool()) {
        Some(true) => 1,
        Some(false) => 2,
        None => 0,
    }
}

pub fn status() -> TelemetryStatus {
    let consent = match CONSENT.load(Ordering::Relaxed) {
        1 => Some(true),
        2 => Some(false),
        _ => None,
    };
    TelemetryStatus { available: APP_KEY.is_some(), consent }
}

pub fn set_consent(agreed: bool) -> Result<(), String> {
    let file = consent_file().ok_or("the data folder is not ready")?;
    std::fs::write(file, serde_json::json!({ "consent": agreed }).to_string()).map_err(|e| e.to_string())?;
    CONSENT.store(if agreed { 1 } else { 2 }, Ordering::Relaxed);
    if agreed {
        track_open();
    }
    Ok(())
}

// ---------- usage stats ----------

fn endpoint(key: &str) -> Option<String> {
    if let Some(host) = APP_HOST {
        return Some(format!("{}/api/v0/event", host.trim_end_matches('/')));
    }
    let region = key.split('-').nth(1)?;
    match region {
        "EU" => Some("https://eu.aptabase.com/api/v0/event".into()),
        "US" => Some("https://us.aptabase.com/api/v0/event".into()),
        _ => None,
    }
}

/// Counts one app launch. Sends the app version, OS and nothing else. No-op unless the user agreed.
fn track_open() {
    let (Some(key), true) = (APP_KEY, CONSENT.load(Ordering::Relaxed) == 1) else { return };
    let Some(url) = endpoint(key) else { return };
    let now = crate::state::now_secs();
    // Aptabase groups events by session; a fresh random one per launch, never stored.
    let session = now * 100_000_000 + random() % 100_000_000;
    let body = serde_json::json!({
        "timestamp": iso8601(now),
        "sessionId": session.to_string(),
        "eventName": "app_open",
        "systemProps": {
            "isDebug": cfg!(debug_assertions),
            "osName": std::env::consts::OS,
            "osVersion": crate::platform::os_version(),
            "appVersion": VERSION,
            "sdkVersion": "disklens-curl@1",
        },
        "props": {},
    })
    .to_string();
    let key = key.to_string();
    std::thread::spawn(move || {
        let child = Command::new("curl")
            .args(["-fsS", "--max-time", "8", "-X", "POST", "-H", "Content-Type: application/json", "-H"])
            .arg(format!("App-Key: {key}"))
            .args(["--data-binary", "@-", &url])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(body.as_bytes());
            }
            let _ = child.wait();
        }
    });
}

fn random() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

/// `2026-10-15T08:30:00Z` from unix seconds.
fn iso8601(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------- crash logs ----------

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        let at = info.location().map_or_else(String::new, |l| format!("{}:{}", l.file(), l.line()));
        let trace = std::backtrace::Backtrace::force_capture();
        write_crash("panic", &format!("{msg}\nat {at}\nthread: {}\n\n{trace}", thread.name().unwrap_or("unnamed")));
        previous(info);
    }));
}

/// Saves one crash report as `crash-<unix time>-<kind>.log`, keeping the newest `MAX_CRASH_LOGS`.
pub fn write_crash(kind: &str, detail: &str) {
    let Some(dir) = crash_dir() else { return };
    let mut text = format!(
        "DiskLens {VERSION}\n{} ({})\n{}\n\n{detail}\n",
        crate::platform::os_version(),
        std::env::consts::ARCH,
        iso8601(crate::state::now_secs()),
    );
    text = scrub(&text);
    if text.len() > MAX_LOG_BYTES {
        let mut end = MAX_LOG_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(format!("crash-{}-{kind}.log", crate::state::now_secs())), text);
    prune(&dir);
}

/// An error thrown in the UI. Limited per run so a render loop can't fill the disk.
pub fn write_ui_error(message: &str, stack: &str) {
    if UI_ERRORS.fetch_add(1, Ordering::Relaxed) < MAX_UI_ERRORS {
        write_crash("ui", &format!("{message}\n\n{stack}"));
    }
}

fn prune(dir: &Path) {
    let mut logs = list_in(dir);
    logs.sort_by(|a, b| b.name.cmp(&a.name));
    for old in logs.into_iter().skip(MAX_CRASH_LOGS) {
        let _ = std::fs::remove_file(dir.join(old.name));
    }
}

fn list_in(dir: &Path) -> Vec<CrashLog> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    read.flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("crash-"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some(CrashLog { name: e.file_name().to_string_lossy().into_owned(), modified, size: meta.len() })
        })
        .collect()
}

/// Newest first.
pub fn crash_logs() -> Vec<CrashLog> {
    let mut logs = crash_dir().map(|d| list_in(&d)).unwrap_or_default();
    logs.sort_by(|a, b| b.name.cmp(&a.name));
    logs
}

/// Replaces the home folder with `~` and any `/Users/<name>` or `/home/<name>` with `~user`, so
/// a report never carries the user's name or folder names above the project.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    if let Some(home) = crate::platform::home().and_then(|h| h.to_str().map(str::to_owned)) {
        if home.len() > 1 {
            out = out.replace(&home, "~");
        }
    }
    for prefix in ["/Users/", "/home/"] {
        let mut result = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(i) = rest.find(prefix) {
            result.push_str(&rest[..i]);
            result.push_str("~user");
            let after = &rest[i + prefix.len()..];
            let end = after.find(|c: char| c == '/' || c.is_whitespace() || c == ':' || c == '"').unwrap_or(after.len());
            rest = &after[end..];
        }
        result.push_str(rest);
        out = result;
    }
    out
}

// ---------- issue report ----------

fn percent_encode(s: &str) -> String {
    s.bytes().fold(String::with_capacity(s.len() * 3), |mut out, b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
        out
    })
}

fn report_body(logs: &[CrashLog], excerpt_lines: usize) -> String {
    let mut body = format!(
        "**What happened?**\n<!-- Describe the problem and what you expected. -->\n\n**Diagnostics**\n- DiskLens: {VERSION}\n- OS: {} ({})\n- Crash logs on this machine: {}\n",
        crate::platform::os_version(),
        std::env::consts::ARCH,
        logs.len(),
    );
    if excerpt_lines > 0 {
        if let (Some(latest), Some(dir)) = (logs.first(), crash_dir()) {
            if let Ok(text) = std::fs::read_to_string(dir.join(&latest.name)) {
                let excerpt: Vec<&str> = text.lines().take(excerpt_lines).collect();
                body.push_str(&format!("\n<details><summary>Latest crash log ({})</summary>\n\n```\n{}\n```\n</details>\n", latest.name, excerpt.join("\n")));
            }
        }
    }
    scrub(&body)
}

/// The text of a bug report and a prefilled GitHub issue link. The link carries as much of the
/// newest crash log as fits in a URL; the full file stays in the crash folder to attach.
pub fn issue_report() -> IssueReport {
    let logs = crash_logs();
    let link = |body: &str| format!("{ISSUES_URL}?title={}&body={}", percent_encode("[Bug] "), percent_encode(body));
    for lines in [40, 20, 10, 0] {
        let body = report_body(&logs, lines);
        let url = link(&body);
        if url.len() <= MAX_URL_LEN || lines == 0 {
            return IssueReport { body, url };
        }
    }
    unreachable!("the last iteration always returns")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_user_names() {
        assert_eq!(scrub("open /Users/alice/Documents/x failed"), "open ~user/Documents/x failed");
        assert_eq!(scrub("at /home/bob/.cargo/src.rs:10"), "at ~user/.cargo/src.rs:10");
        assert_eq!(scrub("nothing here"), "nothing here");
    }

    #[test]
    fn formats_utc_time() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_781_512_200), "2026-06-15T08:30:00Z");
    }

    #[test]
    fn encodes_urls() {
        assert_eq!(percent_encode("a b&c\n"), "a%20b%26c%0A");
    }

    #[test]
    fn saves_and_lists_crash_logs() {
        let dir = std::env::temp_dir().join(format!("disklens-diag-{}", std::process::id()));
        init(dir.clone()); // the one test that sets the global folder
        write_crash("ui", "boom at /home/carol/project/a.ts:1");
        let logs = crash_logs();
        assert_eq!(logs.len(), 1);
        let text = std::fs::read_to_string(dir.join("crashes").join(&logs[0].name)).unwrap();
        assert!(text.contains("boom at ~user/project/a.ts:1") && !text.contains("carol"));
        assert!(issue_report().body.contains("Latest crash log"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn report_url_stays_short() {
        assert!(issue_report().url.len() <= MAX_URL_LEN);
    }
}
