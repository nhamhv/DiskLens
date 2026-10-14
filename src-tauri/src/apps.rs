//! Installed applications: metadata, icons, footprint (bundle + data in ~/Library)
//! and update checks against the Mac App Store and Sparkle feeds.

use crate::scanner::{self, ScanCtx};
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub path: String,
    pub name: String,
    pub bundle_id: Option<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    /// Unix seconds, from Spotlight; None when never opened or not indexed.
    pub last_used: Option<u64>,
    /// "appstore" | "sparkle" | "other" — decides how updates can be checked.
    pub source: &'static str,
    #[serde(skip)]
    pub feed_url: Option<String>,
    #[serde(skip)]
    pub names: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DataPath {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    pub path: String,
    pub bundle: u64,
    pub data: Vec<DataPath>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub path: String,
    pub latest: Option<String>,
    pub available: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// `.app` bundles in /Applications, its sub-folders (e.g. "Utilities") and ~/Applications.
fn bundle_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut dirs = vec![PathBuf::from("/Applications"), home().join("Applications")];
    let mut depth = 0;
    while !dirs.is_empty() && depth < 2 {
        let mut next = Vec::new();
        for dir in dirs {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                if !ft.is_dir() {
                    continue;
                }
                if p.extension().is_some_and(|x| x == "app") {
                    out.push(p);
                } else {
                    next.push(p);
                }
            }
        }
        dirs = next;
        depth += 1;
    }
    out.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    out
}

fn read_info(path: &Path) -> AppInfo {
    let dict = plist::Value::from_file(path.join("Contents/Info.plist"))
        .ok()
        .and_then(|v| v.into_dictionary());
    let get = |k: &str| dict.as_ref().and_then(|d| d.get(k)).and_then(|v| v.as_string()).map(str::to_owned);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let feed_url = get("SUFeedURL");
    let source = if path.join("Contents/_MASReceipt/receipt").exists() {
        "appstore"
    } else if feed_url.is_some() {
        "sparkle"
    } else {
        "other"
    };
    let mut names = vec![stem.clone()];
    for k in ["CFBundleName", "CFBundleDisplayName"] {
        if let Some(n) = get(k) {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    AppInfo {
        path: path.to_string_lossy().into_owned(),
        name: get("CFBundleDisplayName").filter(|n| !n.is_empty()).unwrap_or(stem),
        bundle_id: get("CFBundleIdentifier"),
        version: get("CFBundleShortVersionString"),
        build: get("CFBundleVersion"),
        last_used: None,
        source,
        feed_url,
        names,
    }
}

/// "2026-10-13 00:48:21 +0000" → unix seconds.
fn parse_md_date(s: &str) -> Option<u64> {
    let (date, rest) = s.trim().split_once(' ')?;
    let time = rest.split(' ').next()?;
    let d: Vec<i64> = date.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let t: Vec<i64> = time.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let (y, m, day) = (d[0] - (d[1] <= 2) as i64, d[1], d[2]);
    // Days from civil (Howard Hinnant).
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + t[0] * 3600 + t[1] * 60 + t[2]).ok()
}

/// One `mdls` call for every app; values come back NUL-separated in argument order.
fn last_used_dates(paths: &[PathBuf]) -> Vec<Option<u64>> {
    let out = Command::new("mdls").args(["-raw", "-name", "kMDItemLastUsedDate"]).args(paths).output();
    let Ok(out) = out else { return vec![None; paths.len()] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut vals: Vec<Option<u64>> = text.split('\0').map(parse_md_date).collect();
    vals.resize(paths.len(), None);
    vals
}

pub fn list() -> Vec<AppInfo> {
    let paths = bundle_paths();
    let mut apps: Vec<AppInfo> = paths.par_iter().map(|p| read_info(p)).collect();
    for (app, used) in apps.iter_mut().zip(last_used_dates(&paths)) {
        app.last_used = used;
    }
    apps
}

/// Where apps keep their data, matched by bundle id or exact app name only — never fuzzy,
/// so another app's folder is never offered for deletion.
fn data_paths(info: &AppInfo) -> Vec<PathBuf> {
    let lib = home().join("Library");
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if fs::symlink_metadata(&p).is_ok() && !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(id) = info.bundle_id.as_deref().filter(|id| id.contains('.')) {
        for dir in ["Application Support", "Caches", "Containers", "HTTPStorages", "WebKit", "Logs", "Application Scripts"] {
            add(lib.join(dir).join(id));
        }
        add(lib.join("Preferences").join(format!("{id}.plist")));
        add(lib.join("Saved Application State").join(format!("{id}.savedState")));
        add(lib.join("HTTPStorages").join(format!("{id}.binarycookies")));
        add(lib.join("Cookies").join(format!("{id}.binarycookies")));
        if let Ok(rd) = fs::read_dir(lib.join("Group Containers")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n == format!("group.{id}") || n.ends_with(&format!(".{id}")) {
                    add(e.path());
                }
            }
        }
    }
    for name in &info.names {
        // Very short names ("Go", "Qt") are too likely to belong to something else.
        if name.len() < 3 {
            continue;
        }
        for dir in ["Application Support", "Caches", "Logs"] {
            add(lib.join(dir).join(name));
        }
    }
    out
}

fn measure(path: &Path) -> (u64, bool) {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::symlink_metadata(path) else { return (0, false) };
    if !meta.is_dir() {
        return (meta.blocks() * 512, false);
    }
    let is_dir = true;
    let ctx = ScanCtx::new(path, Arc::new(AtomicBool::new(false)));
    let size = scanner::scan_root(path, &ctx, &|_| {}).map_or(0, |n| n.size);
    (size, is_dir)
}

pub fn footprint(path: &Path) -> Footprint {
    let info = read_info(path);
    let (bundle, _) = measure(path);
    let mut data: Vec<DataPath> = data_paths(&info)
        .into_iter()
        .map(|p| {
            let (size, is_dir) = measure(&p);
            DataPath { path: p.to_string_lossy().into_owned(), size, is_dir }
        })
        .collect();
    data.sort_by_key(|d| std::cmp::Reverse(d.size));
    Footprint { path: info.path, bundle, data }
}

// ---------- icons ----------

/// PNG of the Finder icon via NSWorkspace, so apps that only ship an asset catalog work too.
pub fn icon_png(path: &str, px: f64) -> Option<Vec<u8>> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    objc2::rc::autoreleasepool(|_| unsafe {
        let ws = NSWorkspace::sharedWorkspace();
        let image = ws.iconForFile(&NSString::from_str(path));
        let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(px, px));
        let cg = image.CGImageForProposedRect_context_hints(&mut rect, None, None)?;
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
        let png = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
        Some(png.to_vec())
    })
}

// ---------- updates ----------

fn curl(url: &str) -> Result<String, String> {
    let out = Command::new("curl")
        .args(["-fsSL", "--max-time", "10", "-A", "DiskLens/0.1", url])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("HTTP request failed ({})", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Numeric, segment-wise comparison: "1.10.2" > "1.9".
fn newer(candidate: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).filter_map(|x| x.parse().ok()).collect()
    };
    let (a, b) = (parse(candidate), parse(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn store_country() -> Option<String> {
    let out = Command::new("defaults").args(["read", "-g", "AppleLocale"]).output().ok()?;
    let locale = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    locale.split(['_', '@']).nth(1).filter(|c| c.len() == 2).map(|c| c.to_lowercase())
}

fn check_app_store(id: &str, country: Option<&str>) -> Result<(Option<String>, Option<String>), String> {
    let mut urls = Vec::new();
    if let Some(c) = country {
        urls.push(format!("https://itunes.apple.com/lookup?bundleId={id}&country={c}"));
    }
    urls.push(format!("https://itunes.apple.com/lookup?bundleId={id}"));
    for url in urls {
        let v: serde_json::Value = serde_json::from_str(&curl(&url)?).map_err(|e| e.to_string())?;
        if let Some(r) = v["results"].get(0) {
            let s = |k: &str| r[k].as_str().map(str::to_owned);
            return Ok((s("version"), s("trackViewUrl")));
        }
    }
    Ok((None, None))
}

/// Highest version advertised by a Sparkle appcast: (short version, build).
fn check_sparkle(feed: &str) -> Result<(Option<String>, Option<String>), String> {
    let xml = curl(feed)?;
    let mut best_short: Option<String> = None;
    let mut best_build: Option<String> = None;
    let keep = |slot: &mut Option<String>, v: String| {
        if slot.as_deref().is_none_or(|cur| newer(&v, cur)) {
            *slot = Some(v);
        }
    };
    for (tag, is_short) in [("sparkle:shortVersionString", true), ("sparkle:version", false)] {
        // Both forms appear in the wild: an attribute on <enclosure> and a child element.
        for (i, _) in xml.match_indices(tag) {
            let after = &xml[i + tag.len()..];
            let value = if let Some(rest) = after.strip_prefix("=\"") {
                rest.split('"').next()
            } else if let Some(rest) = after.strip_prefix('>') {
                rest.split('<').next()
            } else {
                None
            };
            if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
                keep(if is_short { &mut best_short } else { &mut best_build }, v.to_owned());
            }
        }
    }
    Ok((best_short, best_build))
}

pub fn check_updates(paths: Vec<String>) -> Vec<UpdateInfo> {
    let country = store_country();
    let pool = rayon::ThreadPoolBuilder::new().num_threads(8).build().expect("update pool");
    pool.install(|| {
        paths
            .par_iter()
            .map(|path| {
                let info = read_info(Path::new(path));
                let current = info.version.clone().unwrap_or_default();
                let mut out = UpdateInfo { path: path.clone(), latest: None, available: false, url: None, error: None };
                let res = match (info.source, &info.bundle_id, &info.feed_url) {
                    ("appstore", Some(id), _) => check_app_store(id, country.as_deref()).map(|(latest, url)| {
                        out.available = latest.as_deref().is_some_and(|l| newer(l, &current));
                        out.latest = latest;
                        out.url = url;
                    }),
                    ("sparkle", _, Some(feed)) => check_sparkle(feed).map(|(short, build)| {
                        let build_now = info.build.clone().unwrap_or_default();
                        out.available = match (&short, &build) {
                            (Some(s), _) if !current.is_empty() => newer(s, &current),
                            (_, Some(b)) => newer(b, &build_now),
                            _ => false,
                        };
                        out.latest = short.or(build);
                    }),
                    _ => Err("This app updates itself; it can't be checked from here".into()),
                };
                out.error = res.err();
                out
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spotlight_dates() {
        assert_eq!(parse_md_date("1970-01-02 00:00:10 +0000"), Some(86410));
        assert_eq!(parse_md_date("2024-03-01 00:00:00 +0000"), Some(1709251200));
        assert_eq!(parse_md_date("(null)"), None);
    }

    /// Smoke test against the real machine: `cargo test live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live() {
        let apps = list();
        println!("{} apps", apps.len());
        for a in apps.iter().take(8) {
            println!("{} {:?} {:?} {} {:?}", a.name, a.bundle_id, a.version, a.source, a.last_used);
        }
        let first = &apps[0].path;
        println!("icon bytes: {:?}", icon_png(first, 128.0).map(|b| b.len()));
        let f = footprint(Path::new(first));
        println!("bundle {} data {:?}", f.bundle, f.data.iter().map(|d| (&d.path, d.size)).collect::<Vec<_>>());
        let checkable: Vec<String> = apps.iter().filter(|a| a.source != "other").take(6).map(|a| a.path.clone()).collect();
        for u in check_updates(checkable) {
            println!("{} latest={:?} avail={} err={:?}", u.path, u.latest, u.available, u.error);
        }
    }

    #[test]
    fn compares_versions() {
        assert!(newer("1.10.2", "1.9"));
        assert!(!newer("1.9", "1.9.0"));
        assert!(newer("2024.2", "2023.12.1"));
    }
}
