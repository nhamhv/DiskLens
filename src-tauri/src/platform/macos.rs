//! macOS: Finder conventions, Full Disk Access, Time Machine, Quick Look, ImageIO.

use super::{Features, Gray, HiddenSpace, RootScan};
use crate::state::Speed;
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

pub fn features() -> Features {
    Features { os: "macos", apps: true, full_disk_access: true, hidden_space: true, quick_look: true, heic: true }
}

/// Runs on each scan thread as it starts.
pub fn set_thread_priority(speed: Speed) {
    use libc::qos_class_t::*;
    // Background QoS keeps the threads on efficiency cores and throttles their disk I/O.
    let qos = match speed {
        Speed::Low => QOS_CLASS_BACKGROUND,
        Speed::Balanced => QOS_CLASS_UTILITY,
        Speed::Fast => QOS_CLASS_USER_INITIATED,
    };
    unsafe {
        libc::pthread_set_qos_class_self_np(qos, 0);
    }
}

/// "/" is the sealed system volume and user data lives on the Data volume, firmlinked into
/// "/" (/Users, /Applications, ...). Accept both devices but skip the Data mount point
/// itself so nothing is counted twice. `/.vol`, `/.nofollow` and `/.resolve` are APFS magic
/// folders that can expose the whole volume a second time by another path.
pub fn root_scan() -> RootScan {
    RootScan {
        devices: std::fs::metadata("/System/Volumes/Data").map(|m| m.dev()).into_iter().collect(),
        skip: ["/System/Volumes/Data", "/Volumes", "/dev", "/net", "/home", "/.vol", "/.nofollow", "/.resolve"]
            .map(PathBuf::from)
            .to_vec(),
    }
}

/// Top-level items of the user's Trash live directly in it.
pub fn trash_files() -> Option<PathBuf> {
    Some(super::home()?.join(".Trash"))
}

/// The trash keeps no metadata beside each item.
pub fn trash_info(_item: &Path) -> Option<PathBuf> {
    None
}

/// `/usr/bin/git` is avoided: without the Command Line Tools it pops up an install dialog
/// instead of running.
pub const GIT_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
];

/// The open Quick Look preview and the paths it shows.
static QUICK_LOOK: Mutex<Option<(std::process::Child, Vec<String>)>> = Mutex::new(None);

/// Toggles a Quick Look preview of `paths` (`qlmanage -p`). Closes the open preview; opens a
/// new one unless it was showing the same paths. Returns whether a preview is now open.
pub fn quick_look(paths: Vec<String>) -> Result<bool, String> {
    let mut slot = QUICK_LOOK.lock().unwrap();
    if let Some((mut child, shown)) = slot.take() {
        let open = matches!(child.try_wait(), Ok(None));
        let _ = child.kill();
        let _ = child.wait();
        if open && shown == paths {
            return Ok(false);
        }
    }
    if paths.is_empty() {
        return Ok(false);
    }
    let child = Command::new("/usr/bin/qlmanage")
        .arg("-p")
        .args(&paths)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    *slot = Some((child, paths));
    Ok(true)
}

pub fn open_privacy_settings() -> Result<(), String> {
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// TCC.db is only readable by processes that hold Full Disk Access.
/// Note: in `tauri dev` the permission belongs to the app that launched the
/// binary (VS Code, iTerm, ...), not to this app.
pub fn has_full_disk_access() -> bool {
    super::home().is_some_and(|home| std::fs::File::open(home.join("Library/Application Support/com.apple.TCC/TCC.db")).is_ok())
}

pub fn hidden_space() -> HiddenSpace {
    let free = super::disk_space().map_or(0, |d| d.1);
    HiddenSpace { snapshots: local_snapshots(), purgeable: important_free().map_or(0, |v| v.saturating_sub(free)) }
}

/// Asks macOS to delete the Time Machine local snapshots (`tmutil thinlocalsnapshots` at the
/// highest urgency). Backups on the backup disk are not touched. Returns how many are left.
pub fn thin_snapshots() -> Result<usize, String> {
    let out = Command::new("/usr/bin/tmutil")
        .args(["thinlocalsnapshots", "/", "999999999999", "4"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(local_snapshots().len())
}

fn local_snapshots() -> Vec<String> {
    let out = Command::new("/usr/bin/tmutil").args(["listlocalsnapshots", "/"]).output();
    out.map_or_else(|_| Vec::new(), |o| parse_snapshots(&String::from_utf8_lossy(&o.stdout)))
}

/// `com.apple.TimeMachine.2026-10-14-101500.local` → `2026-10-14-101500`.
fn parse_snapshots(out: &str) -> Vec<String> {
    out.lines()
        .filter_map(|l| l.trim().strip_prefix("com.apple.TimeMachine."))
        .map(|l| l.trim_end_matches(".local").to_string())
        .collect()
}

/// Free space counting what macOS would purge for an important download or update.
fn important_free() -> Option<u64> {
    use objc2_foundation::{NSNumber, NSString, NSURLVolumeAvailableCapacityForImportantUsageKey, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str("/"));
    let mut value = None;
    unsafe { url.getResourceValue_forKey_error(&mut value, NSURLVolumeAvailableCapacityForImportantUsageKey) }.ok()?;
    let n = value?.downcast::<NSNumber>().ok()?;
    u64::try_from(n.longLongValue()).ok()
}

/// Files Spotlight marks as screen captures.
pub fn screen_captures(dirs: &[PathBuf]) -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    for d in dirs {
        let out = Command::new("/usr/bin/mdfind").arg("-onlyin").arg(d).arg("kMDItemIsScreenCapture == 1").output();
        if let Ok(o) = out {
            set.extend(String::from_utf8_lossy(&o.stdout).lines().map(PathBuf::from));
        }
    }
    set
}

/// The image at `path` as a greyscale bitmap at most `px` on its long side, upright.
pub fn thumbnail_gray(path: &Path, px: i32) -> Option<Gray> {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo};

    let img = thumbnail(path, px)?;
    let (w, h) = (CGImage::width(Some(&img)), CGImage::height(Some(&img)));
    if w == 0 || h == 0 {
        return None;
    }
    let mut pixels = vec![0u8; w * h];
    let space = CGColorSpace::new_device_gray()?;
    // SAFETY: `pixels` holds w*h bytes, one 8-bit grey component per pixel, and outlives `ctx`.
    let ctx = unsafe { CGBitmapContextCreate(pixels.as_mut_ptr().cast(), w, h, 8, w, Some(&space), CGImageAlphaInfo::None.0) }?;
    CGContext::draw_image(Some(&ctx), CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64)), Some(&img));
    drop(ctx);
    Some(Gray { pixels, width: w, height: h })
}

/// An upright thumbnail at most `px` on its long side, made by ImageIO (decodes HEIC too).
fn thumbnail(path: &Path, px: i32) -> Option<objc2_core_foundation::CFRetained<objc2_core_graphics::CGImage>> {
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFString, CFType, CFURL};
    use objc2_image_io::{
        kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCache,
        kCGImageSourceThumbnailMaxPixelSize, CGImageSource,
    };

    let url = CFURL::from_file_path(path)?;
    let size = CFNumber::new_i32(px);
    let (yes, no) = (CFBoolean::new(true), CFBoolean::new(false));
    // SAFETY: the keys are ImageIO's option constants and the values have the documented types.
    unsafe {
        let keys: [&CFString; 4] = [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
            kCGImageSourceShouldCache,
        ];
        let values: [&CFType; 4] = [yes, yes, &size, no];
        let options = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
        let source = CGImageSource::with_url(&url, None)?;
        source.thumbnail_at_index(0, Some(options.as_opaque()))
    }
}

/// A JPEG thumbnail at most `px` on its long side.
pub fn thumbnail_jpeg(path: &Path, px: i32) -> Option<Vec<u8>> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let img = thumbnail(path, px)?;
    objc2::rc::autoreleasepool(|_| unsafe {
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &img);
        rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &NSDictionary::new()).map(|d| d.to_vec())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_time_machine_snapshots() {
        let out = "Snapshots for disk /:\ncom.apple.TimeMachine.2026-10-14-101500.local\ncom.apple.os.update-ABC\n";
        assert_eq!(super::parse_snapshots(out), ["2026-10-14-101500"]);
    }

    #[test]
    fn reads_important_capacity() {
        let important = super::important_free().expect("volume capacity");
        let free = super::super::disk_space().unwrap().1;
        assert!(important + (1 << 30) >= free);
    }
}
