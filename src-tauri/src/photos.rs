//! Photo cleanup: likely-blurry shots, screen captures and groups of near-identical photos.
//!
//! Everything is on-device. A ≤256 px greyscale thumbnail of each photo is decoded once (ImageIO
//! on macOS, the `image` crate elsewhere); from it we get a focus score (variance of the
//! Laplacian) and a 64-bit difference hash.
//! Photos whose hashes differ in only a few bits (resized, re-encoded, burst shots) are grouped.
//! Nothing here deletes anything: the UI sends picked files through `delete_paths`.

use crate::classify;
use crate::platform::{self, has_ext};
use rayon::prelude::*;
use serde::Serialize;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff", "webp", "gif", "bmp"];
/// Only camera formats get a blur score: flat graphics and screenshots would all look "blurry".
const PHOTO_EXTS: &[&str] = &["jpg", "jpeg", "heic", "heif"];
/// Icons, emoji and other tiny images aren't worth reviewing.
const MIN_BYTES: u64 = 20_000;
/// Keeps the pairwise comparison and the scan time bounded.
pub const MAX_IMAGES: usize = 20_000;
/// Laplacian variance on a ≤256 px greyscale thumbnail below which a photo is probably out of focus.
/// Deliberately low, to avoid flagging soft but intended shots.
pub const BLUR_THRESHOLD: f64 = 70.0;
/// Max differing bits (of 64) for two photos to count as the same picture.
pub const SIMILAR_BITS: u32 = 6;
const THUMB_PX: i32 = 256;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Unix seconds.
    pub modified: u64,
    /// Focus score; lower is blurrier. Only for camera formats.
    pub sharpness: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoReport {
    /// Images looked at.
    pub scanned: usize,
    /// More than `MAX_IMAGES` were found; the newest were kept.
    pub truncated: bool,
    /// Blurriest first.
    pub blurry: Vec<Photo>,
    /// Largest first.
    pub screenshots: Vec<Photo>,
    /// Each group has the suggested photo to keep first (the largest file). Groups with the
    /// most reclaimable space first.
    pub similar: Vec<Vec<Photo>>,
}

#[derive(Serialize, Clone)]
pub struct PhotoProgress {
    pub done: usize,
    pub total: usize,
}

struct Analysed {
    photo: Photo,
    screenshot: bool,
    /// Difference hash and aspect bucket, when the image could be decoded.
    hash: Option<(u64, u8)>,
}

struct Found {
    path: PathBuf,
    size: u64,
    modified: u64,
}

/// Image files under `dir`, skipping hidden folders, symlinks and bundles (such as a Photos
/// library, whose files belong to Photos and must not be removed behind its back).
fn collect(dir: &Path, cancel: &AtomicBool, out: &mut Vec<Found>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.filter_map(Result::ok) {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        let path = e.path();
        if meta.is_dir() {
            if !classify::is_bundle(&name) && !has_ext(&path, &["photoslibrary", "photolibrary", "aplibrary"]) {
                collect(&path, cancel, out);
            }
        } else if meta.is_file() && meta.len() >= MIN_BYTES && has_ext(&path, IMAGE_EXTS) {
            out.push(Found { path, size: meta.blocks() * 512, modified: meta.mtime().max(0) as u64 });
        }
    }
}

/// HEIC files are listed everywhere but only decoded where the OS can (macOS).
fn decodable(p: &Path) -> bool {
    platform::features().heic || !has_ext(p, &["heic", "heif"])
}

/// Common screenshot file names in each UI language (macOS, GNOME, KDE, CleanShot).
fn looks_like_screenshot(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "screenshot", "screen shot", "cleanshot", "ảnh màn hình", "スクリーンショット", "截屏", "屏幕快照", "스크린샷",
        "captura de pantalla", "capture d’écran", "capture d'écran", "bildschirmfoto", "istantanea", "captura de tela",
        "снимок экрана", "tangkapan layar",
    ];
    let lower = name.to_lowercase();
    PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// Scans `dirs`. `progress(done, total)` is called from worker threads. `None` if cancelled.
pub fn scan(dirs: &[PathBuf], cancel: &AtomicBool, progress: &(dyn Fn(usize, usize) + Sync)) -> Option<PhotoReport> {
    let mut found = Vec::new();
    for d in dirs {
        collect(d, cancel, &mut found);
    }
    // The same file reached through two chosen folders.
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found.dedup_by(|a, b| a.path == b.path);
    let truncated = found.len() > MAX_IMAGES;
    if truncated {
        found.sort_unstable_by_key(|f| std::cmp::Reverse(f.modified));
        found.truncate(MAX_IMAGES);
    }
    let captures = platform::screen_captures(dirs);

    let total = found.len();
    let done = AtomicUsize::new(0);
    let analysed: Vec<Analysed> = found
        .into_par_iter()
        .filter_map(|f| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let name = f.path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let screenshot = captures.contains(&f.path) || looks_like_screenshot(&name);
            let gray = decodable(&f.path).then(|| platform::thumbnail_gray(&f.path, THUMB_PX)).flatten();
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_multiple_of(25) || n == total {
                progress(n, total);
            }
            let sharpness = gray
                .as_ref()
                .filter(|_| !screenshot && has_ext(&f.path, PHOTO_EXTS))
                .map(|g| laplacian_variance(&g.pixels, g.width, g.height));
            let hash = gray.as_ref().map(|g| (dhash(&g.pixels, g.width, g.height), aspect_bucket(g.width, g.height)));
            let photo = Photo {
                path: f.path.to_string_lossy().into_owned(),
                name,
                size: f.size,
                modified: f.modified,
                sharpness,
            };
            Some(Analysed { photo, screenshot, hash })
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    let mut blurry: Vec<Photo> =
        analysed.iter().filter(|a| a.photo.sharpness.is_some_and(|s| s < BLUR_THRESHOLD)).map(|a| a.photo.clone()).collect();
    blurry.sort_by(|a, b| a.sharpness.partial_cmp(&b.sharpness).unwrap_or(std::cmp::Ordering::Equal));
    let mut screenshots: Vec<Photo> = analysed.iter().filter(|a| a.screenshot).map(|a| a.photo.clone()).collect();
    screenshots.sort_unstable_by_key(|p| std::cmp::Reverse(p.size));

    let hashed: Vec<(usize, u64, u8)> =
        analysed.iter().enumerate().filter_map(|(i, a)| a.hash.map(|(h, b)| (i, h, b))).collect();
    let mut similar: Vec<Vec<Photo>> = group_similar(&hashed, SIMILAR_BITS)
        .into_iter()
        .map(|g| {
            let mut photos: Vec<Photo> = g.into_iter().map(|i| analysed[i].photo.clone()).collect();
            photos.sort_unstable_by_key(|p| std::cmp::Reverse(p.size));
            photos
        })
        .collect();
    similar.sort_unstable_by_key(|g| std::cmp::Reverse(g.iter().skip(1).map(|p| p.size).sum::<u64>()));

    Some(PhotoReport { scanned: total, truncated, blurry, screenshots, similar })
}

/// Greedy clustering: each unassigned photo collects every later unassigned photo of the same
/// shape within `bits` of it. Returns indices (as given in `items`) of groups of two or more.
pub fn group_similar(items: &[(usize, u64, u8)], bits: u32) -> Vec<Vec<usize>> {
    let mut used = vec![false; items.len()];
    let mut groups = Vec::new();
    for i in 0..items.len() {
        if used[i] {
            continue;
        }
        let (_, h, bucket) = items[i];
        let mut group = vec![items[i].0];
        for j in i + 1..items.len() {
            if !used[j] && items[j].2 == bucket && (items[j].1 ^ h).count_ones() <= bits {
                used[j] = true;
                group.push(items[j].0);
            }
        }
        if group.len() > 1 {
            groups.push(group);
        }
    }
    groups
}

/// Coarse width/height ratio, so a crop or a portrait/landscape pair isn't matched.
fn aspect_bucket(w: usize, h: usize) -> u8 {
    ((w as f64 / h.max(1) as f64).ln() * 8.0).round().clamp(-100.0, 100.0) as i8 as u8
}

/// Variance of the 4-neighbour Laplacian: high for sharp edges, near zero for a blurry or flat image.
pub fn laplacian_variance(px: &[u8], w: usize, h: usize) -> f64 {
    if w < 3 || h < 3 {
        return f64::MAX;
    }
    let (mut sum, mut sq, mut n) = (0.0, 0.0, 0.0);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            let lap = 4.0 * px[i] as f64 - px[i - 1] as f64 - px[i + 1] as f64 - px[i - w] as f64 - px[i + w] as f64;
            sum += lap;
            sq += lap * lap;
            n += 1.0;
        }
    }
    let mean = sum / n;
    sq / n - mean * mean
}

/// Difference hash: shrink to 9×8 by area averaging, then one bit per pixel for "brighter than
/// its right neighbour". Survives resizing and re-encoding; changes with the picture itself.
pub fn dhash(px: &[u8], w: usize, h: usize) -> u64 {
    let mut cells = [[0f64; 9]; 8];
    for (cy, row) in cells.iter_mut().enumerate() {
        let (y0, y1) = (cy * h / 8, ((cy + 1) * h / 8).max(cy * h / 8 + 1).min(h));
        for (cx, cell) in row.iter_mut().enumerate() {
            let (x0, x1) = (cx * w / 9, ((cx + 1) * w / 9).max(cx * w / 9 + 1).min(w));
            let mut sum = 0u64;
            for y in y0..y1 {
                sum += px[y * w + x0..y * w + x1].iter().map(|&p| p as u64).sum::<u64>();
            }
            *cell = sum as f64 / ((y1 - y0) * (x1 - x0)).max(1) as f64;
        }
    }
    let mut hash = 0u64;
    for row in &cells {
        for x in 0..8 {
            hash = (hash << 1) | (row[x] > row[x + 1]) as u64;
        }
    }
    hash
}

/// A JPEG thumbnail for the UI, as a data URL.
pub fn thumbnail_data_url(path: &Path, px: i32) -> Option<String> {
    use base64::Engine;
    let jpeg = platform::thumbnail_jpeg(path, px)?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_and_hash_behave() {
        let (w, h) = (64, 48);
        // Sharp checkerboard vs. a smooth gradient.
        let sharp: Vec<u8> = (0..w * h).map(|i| if (i % w / 4 + i / w / 4) % 2 == 0 { 0 } else { 255 }).collect();
        let smooth: Vec<u8> = (0..w * h).map(|i| (i % w * 4) as u8).collect();
        assert!(laplacian_variance(&sharp, w, h) > BLUR_THRESHOLD);
        assert!(laplacian_variance(&smooth, w, h) < BLUR_THRESHOLD);

        // A brightened copy hashes the same; a different picture doesn't.
        let brighter: Vec<u8> = smooth.iter().map(|&p| p.saturating_add(10)).collect();
        assert!((dhash(&smooth, w, h) ^ dhash(&brighter, w, h)).count_ones() <= SIMILAR_BITS);
        let reversed: Vec<u8> = (0..w * h).map(|i| 255 - (i % w * 4) as u8).collect();
        assert!((dhash(&smooth, w, h) ^ dhash(&reversed, w, h)).count_ones() > SIMILAR_BITS);
    }

    #[test]
    fn groups_only_close_hashes_of_the_same_shape() {
        let items = [(0, 0b1111u64, 0u8), (1, 0b1110, 0), (2, 0b1110, 9), (3, u64::MAX, 0), (4, 0b0111, 0)];
        assert_eq!(group_similar(&items, 2), vec![vec![0, 1, 4]]);
    }

    #[test]
    fn spots_screenshot_names() {
        assert!(looks_like_screenshot("Screenshot 2026-10-14 at 10.00.00.png"));
        assert!(looks_like_screenshot("Ảnh màn hình 2026-10-14 lúc 10.00.00.png"));
        assert!(!looks_like_screenshot("IMG_0001.HEIC"));
    }

    #[test]
    fn decodes_a_real_image() {
        // Any PNG that ships with macOS.
        let p = Path::new("/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns");
        if p.exists() {
            let g = platform::thumbnail_gray(p, THUMB_PX).expect("decoded");
            assert!(g.width <= THUMB_PX as usize && g.height <= THUMB_PX as usize && g.width > 0);
            assert!(thumbnail_data_url(p, 64).is_some_and(|u| u.starts_with("data:image/jpeg;base64,")));
        }
    }
}
