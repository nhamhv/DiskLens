//! Cleanup rules: the built-in catalog plus the user's own file, merged by `id`.
//!
//! The user file is JSON with comments. A rule whose `id` matches a built-in one only
//! overrides the fields it sets (`"disabled": true` turns it off); any other `id` adds a rule.
//! A broken file never stops a scan: the built-in rules still apply and the problems
//! come back as warnings with a line and column.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const BUILTIN: &str = include_str!("../../rules/builtin.json");
pub const TEMPLATE: &str = include_str!("../../rules/template.jsonc");

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Safety {
    /// Regenerated on its own.
    Safe,
    /// Comes back after running a command (install, build, download).
    Rebuild,
    /// May hold something the user can't get back.
    Caution,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A folder inside a project, found by walking the chosen folders.
    Artifact,
    /// Fixed paths (globs allowed).
    Location,
    /// Fixed paths holding several versions of one thing; all but the newest are listed.
    Versioned,
    /// A shared layout (`templates`) applied to each path.
    Template,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Project,
    Sdk,
    Caches,
    Ide,
    Ai,
    Old,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(default = "other")]
    pub eco: String,
    pub category: Option<Category>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub safety: Option<Safety>,
    pub restore: Option<String>,
    /// Handled while merging; declared so the field isn't rejected as unknown.
    #[serde(default)]
    #[allow(dead_code)]
    pub disabled: bool,
    #[serde(default)]
    pub dirs: Vec<String>,
    #[serde(default)]
    pub markers: Vec<String>,
    #[serde(default)]
    pub inside: Vec<String>,
    #[serde(default)]
    pub git_ignored: bool,
    #[serde(default)]
    pub paths: Vec<String>,
    pub template: Option<String>,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default = "one")]
    pub keep: usize,
    /// Not in the built-in catalog: the UI badges it and quick-select skips it.
    #[serde(skip)]
    pub custom: bool,
}

fn other() -> String {
    "other".into()
}
fn one() -> usize {
    1
}

impl Rule {
    pub fn category(&self) -> Category {
        match self.kind {
            Kind::Artifact => Category::Project,
            Kind::Versioned => Category::Old,
            _ => self.category.unwrap_or(Category::Caches),
        }
    }

    pub fn safety(&self) -> Safety {
        self.safety.unwrap_or(Safety::Caution)
    }

    fn validate(&self, templates: &HashMap<String, Vec<TemplateEntry>>) -> Result<(), String> {
        let need = |ok: bool, what: &str| if ok { Ok(()) } else { Err(what.to_string()) };
        match self.kind {
            Kind::Artifact => need(!self.dirs.is_empty(), "an artifact rule needs \"dirs\"")?,
            _ => need(!self.paths.is_empty(), "this rule needs \"paths\"")?,
        }
        if self.kind == Kind::Template {
            let name = self.template.as_deref().ok_or("a template rule needs \"template\"")?;
            need(templates.contains_key(name), &format!("unknown template \"{name}\""))?;
        } else {
            need(self.safety.is_some(), "this rule needs \"safety\"")?;
        }
        if self.dirs.iter().chain(&self.inside).any(|d| d.starts_with('/') || d.split('/').any(|s| s == ".." || s.is_empty())) {
            return Err("\"dirs\" and \"inside\" must be plain relative paths".into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateEntry {
    pub path: String,
    pub safety: Safety,
    pub label: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WalkSection {
    max_depth: Option<usize>,
    #[serde(default)]
    skip_names: Vec<String>,
    #[serde(default)]
    skip_paths: Vec<String>,
}

pub struct Walk {
    pub max_depth: usize,
    pub skip_names: HashSet<String>,
    pub skip_paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub file: String,
    /// 1-based; 0 when the problem has no position.
    pub line: usize,
    pub col: usize,
    pub message: String,
}

/// One row of the rules list in the editor: every rule, including disabled and broken ones.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuleSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub eco: Option<String>,
    pub label: Option<String>,
    pub safety: Option<String>,
    /// Only in the user's file.
    pub custom: bool,
    /// Built in, with fields changed by the user's file.
    pub overridden: bool,
    pub disabled: bool,
    /// Skipped because of a problem (see the warnings).
    pub broken: bool,
    /// The built-in definition, pretty-printed, for copying into the user's file.
    pub builtin: Option<String>,
}

pub struct Catalog {
    pub summary: Vec<RuleSummary>,
    pub rules: Vec<Rule>,
    pub templates: HashMap<String, Vec<TemplateEntry>>,
    pub walk: Walk,
    pub warnings: Vec<Warning>,
    pub builtin: usize,
    pub custom: usize,
    pub disabled: usize,
}

/// One rules file, already parsed.
struct Source<'a> {
    name: String,
    text: &'a str,
    root: Map<String, Value>,
}

impl Source<'_> {
    fn warn(&self, at: Option<&str>, message: String) -> Warning {
        let (line, col) = at.map_or((0, 0), |needle| locate(self.text, needle));
        Warning { file: self.name.clone(), line, col, message }
    }
}

/// Line and column of the first `"needle"` in `text`, so a warning can point at a rule.
fn locate(text: &str, needle: &str) -> (usize, usize) {
    let quoted = format!("\"{needle}\"");
    let Some(pos) = text.find(&quoted) else { return (0, 0) };
    let before = &text[..pos];
    let line = before.matches('\n').count() + 1;
    let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    (line, col)
}

fn parse<'a>(name: &str, text: &'a str, clean: &str) -> Result<Source<'a>, Warning> {
    let fail = |line, col, message| Warning { file: name.into(), line, col, message };
    match serde_json::from_str::<Value>(clean) {
        Ok(Value::Object(root)) => Ok(Source { name: name.into(), text, root }),
        Ok(_) => Err(fail(1, 1, "the file must contain a JSON object".into())),
        Err(e) => Err(fail(e.line(), e.column(), e.to_string())),
    }
}

/// Blanks out `//` and `/* */` comments, so line and column numbers still match the file.
fn strip_comments(text: &str) -> String {
    let mut out = String::new();
    let _ = json_comments::StripComments::new(text.as_bytes()).read_to_string(&mut out);
    out
}

/// Loads the built-in catalog and merges the user's file over it, if there is one.
pub fn load(user: Option<&Path>) -> Catalog {
    let text = user.and_then(|p| std::fs::read_to_string(p).ok());
    let name = user.map(|p| p.display().to_string()).unwrap_or_default();
    load_text(&name, text.as_deref())
}

/// Like [`load`], with the user's file already read (the editor checks unsaved text this way).
pub fn load_text(name: &str, user: Option<&str>) -> Catalog {
    let builtin = parse("builtin", BUILTIN, BUILTIN).expect("built-in rules are valid JSON");
    let mut warnings = Vec::new();
    let user_src = user.and_then(|text| match parse(name, text, &strip_comments(text)) {
        Ok(src) => Some(src),
        Err(w) => {
            warnings.push(w);
            None
        }
    });
    if let Some(src) = &user_src {
        check_top_level(src, &mut warnings);
    }
    merge(&builtin, user_src.as_ref(), warnings)
}

const TOP_LEVEL: [&str; 5] = ["$schema", "version", "walk", "templates", "rules"];

/// Problems serde can't see because the root is read as a loose map.
fn check_top_level(src: &Source, warnings: &mut Vec<Warning>) {
    for key in src.root.keys().filter(|k| !TOP_LEVEL.contains(&k.as_str())) {
        warnings.push(src.warn(Some(key), format!("unknown key \"{key}\" (expected one of: {})", TOP_LEVEL.join(", "))));
    }
    if let Some(v) = src.root.get("version").filter(|v| v.as_u64() != Some(1)) {
        warnings.push(src.warn(Some("version"), format!("\"version\" must be 1, not {v}")));
    }
    let mut seen = HashSet::new();
    for id in src.root.get("rules").and_then(Value::as_array).into_iter().flatten().filter_map(|r| r.get("id")?.as_str()) {
        if !seen.insert(id) {
            warnings.push(src.warn(Some(id), format!("rule \"{id}\" appears twice; the later one's fields win")));
        }
    }
}

fn merge(builtin: &Source, user: Option<&Source>, mut warnings: Vec<Warning>) -> Catalog {
    let sources: Vec<&Source> = std::iter::once(builtin).chain(user).collect();

    let mut templates: HashMap<String, Vec<TemplateEntry>> = HashMap::new();
    let mut walk = WalkSection::default();
    for src in &sources {
        for (name, value) in src.root.get("templates").and_then(Value::as_object).into_iter().flatten() {
            match serde_json::from_value(value.clone()) {
                Ok(entries) => {
                    templates.insert(name.clone(), entries);
                }
                Err(e) => warnings.push(src.warn(Some(name), format!("template \"{name}\": {e}"))),
            }
        }
        if let Some(value) = src.root.get("walk") {
            match serde_json::from_value::<WalkSection>(value.clone()) {
                Ok(w) => {
                    walk.max_depth = w.max_depth.or(walk.max_depth);
                    walk.skip_names.extend(w.skip_names);
                    walk.skip_paths.extend(w.skip_paths);
                }
                Err(e) => warnings.push(src.warn(Some("walk"), format!("walk: {e}"))),
            }
        }
    }

    // Merge rule objects by id, keeping the built-in order; user-only rules go last.
    let mut order: Vec<String> = Vec::new();
    let mut merged: HashMap<String, (Map<String, Value>, usize, bool)> = HashMap::new();
    let mut originals: HashMap<String, String> = HashMap::new();
    for (src_idx, src) in sources.iter().enumerate() {
        let Some(list) = src.root.get("rules") else { continue };
        let Some(list) = list.as_array() else {
            warnings.push(src.warn(Some("rules"), "\"rules\" must be an array".into()));
            continue;
        };
        for value in list {
            let Some(obj) = value.as_object() else {
                warnings.push(src.warn(Some("rules"), "each rule must be an object".into()));
                continue;
            };
            let Some(id) = obj.get("id").and_then(Value::as_str) else {
                warnings.push(src.warn(Some("rules"), "a rule has no \"id\"".into()));
                continue;
            };
            match merged.get_mut(id) {
                Some((base, last, _)) => {
                    base.extend(obj.clone());
                    *last = src_idx;
                }
                None => {
                    if src_idx == 0 {
                        let pretty = serde_json::to_string_pretty(value).unwrap_or_default();
                        originals.insert(id.to_string(), pretty);
                    }
                    order.push(id.to_string());
                    merged.insert(id.to_string(), (obj.clone(), src_idx, src_idx > 0));
                }
            }
        }
    }

    let (mut rules, mut disabled, mut summary) = (Vec::new(), 0, Vec::new());
    let (mut builtin_count, mut custom_count) = (0, 0);
    for id in order {
        let (obj, last, custom) = merged.remove(&id).expect("every ordered id was merged");
        let src = sources[last];
        let field = |k: &str| obj.get(k).and_then(Value::as_str).map(String::from);
        let mut row = RuleSummary {
            id: id.clone(),
            kind: field("type"),
            eco: field("eco"),
            label: field("label"),
            safety: field("safety"),
            custom,
            overridden: !custom && last > 0,
            disabled: obj.get("disabled").and_then(Value::as_bool) == Some(true),
            broken: false,
            builtin: originals.remove(&id),
        };
        if row.disabled {
            disabled += 1;
            summary.push(row);
            continue;
        }
        let rule = serde_json::from_value::<Rule>(Value::Object(obj))
            .map_err(|e| e.to_string())
            .and_then(|r| r.validate(&templates).map(|_| r));
        match rule {
            Ok(mut r) => {
                r.custom = custom;
                if custom {
                    custom_count += 1;
                } else {
                    builtin_count += 1;
                }
                rules.push(r);
            }
            Err(e) => {
                row.broken = true;
                warnings.push(src.warn(Some(&id), format!("rule \"{id}\" skipped: {e}")));
            }
        }
        summary.push(row);
    }

    Catalog {
        summary,
        rules,
        templates,
        walk: Walk {
            max_depth: walk.max_depth.unwrap_or(10),
            skip_names: walk.skip_names.into_iter().collect(),
            skip_paths: walk.skip_paths,
        },
        warnings,
        builtin: builtin_count,
        custom: custom_count,
        disabled,
    }
}

// ---------- paths ----------

/// Folder holding the real binary `name` (symlinks resolved), searching the usual install
/// places too: apps launched from Finder get a minimal PATH.
fn bin_dir(name: &str, home: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs.extend([".local/bin", "fvm/default/bin", "development/flutter/bin", "flutter/bin", ".cargo/bin"].map(|d| home.join(d)));
    dirs.iter()
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Resolves the leading `~`, `$VAR` or `{bin:name}` of a rule path.
fn resolve_head(pattern: &str, home: &Path) -> Option<PathBuf> {
    let (head, rest) = pattern.split_once('/').unwrap_or((pattern, ""));
    let base = if head == "~" {
        home.to_path_buf()
    } else if let Some(var) = head.strip_prefix('$') {
        PathBuf::from(std::env::var_os(var).filter(|v| !v.is_empty())?)
    } else if let Some(bin) = head.strip_prefix("{bin:").and_then(|h| h.strip_suffix('}')) {
        bin_dir(bin, home)?
    } else if head.is_empty() {
        PathBuf::from("/")
    } else {
        return None;
    };
    Some(if rest.is_empty() { base } else { base.join(rest) })
}

/// `*` matches any run of characters, `?` one character.
pub fn wildcard(pattern: &str, name: &str) -> bool {
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    let (mut pi, mut ni, mut star, mut mark) = (0, 0, None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// Every existing path matching `pattern`. Symlinks at the end are skipped: removing one
/// would not free what its target uses.
pub fn expand(pattern: &str, home: &Path) -> Vec<PathBuf> {
    let Some(full) = resolve_head(pattern, home) else { return Vec::new() };
    let mut found = vec![PathBuf::from("/")];
    for comp in full.components().skip(1) {
        let seg = comp.as_os_str().to_string_lossy();
        found = if seg.contains(['*', '?']) {
            found
                .iter()
                .flat_map(|dir| std::fs::read_dir(dir).into_iter().flatten().flatten())
                .filter(|e| wildcard(&seg, &e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        } else {
            found.into_iter().map(|d| d.join(&*seg)).filter(|p| p.exists()).collect()
        };
        if found.is_empty() {
            break;
        }
    }
    found.retain(|p| std::fs::symlink_metadata(p).is_ok_and(|m| !m.file_type().is_symlink()));
    found.sort();
    found
}

/// Groups versions of the same thing: digits are folded, so `WebStorm2024.3` and
/// `WebStorm2025.3` share a key while `chromium-1228` and `firefox-1465` don't.
pub fn version_group(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_digit() {
            if !out.ends_with('#') {
                out.push('#');
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Natural order: number runs compare as numbers, so `2.1.295` > `2.1.30`.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn chunks(s: &str) -> Vec<Result<u64, char>> {
        let mut out = Vec::new();
        let mut num: Option<u64> = None;
        for c in s.chars() {
            if let Some(d) = c.to_digit(10) {
                num = Some(num.unwrap_or(0).saturating_mul(10).saturating_add(d as u64));
            } else {
                if let Some(n) = num.take() {
                    out.push(Ok(n));
                }
                out.push(Err(c));
            }
        }
        out.extend(num.map(Ok));
        out
    }
    chunks(a).cmp(&chunks(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_rules_are_valid() {
        let cat = load(None);
        assert!(cat.warnings.is_empty(), "{:?}", cat.warnings);
        assert!(cat.builtin > 50);
        let ids: HashSet<_> = cat.rules.iter().map(|r| &r.id).collect();
        assert_eq!(ids.len(), cat.rules.len(), "duplicate rule ids");
    }

    #[test]
    fn template_file_is_valid() {
        let clean = strip_comments(TEMPLATE);
        let src = parse("template", TEMPLATE, &clean).expect("template parses");
        let builtin = parse("builtin", BUILTIN, BUILTIN).unwrap();
        let cat = merge(&builtin, Some(&src), Vec::new());
        assert!(cat.warnings.is_empty(), "{:?}", cat.warnings);
    }

    #[test]
    fn user_rules_merge_by_id() {
        let text = r#"{
          // comments are fine
          "rules": [
            { "id": "node.modules", "safety": "caution" },
            { "id": "rust.target", "disabled": true },
            { "id": "my.cache", "type": "location", "paths": ["~/x"], "safety": "safe" },
            { "id": "broken", "type": "artifact", "safety": "safe" }
          ]
        }"#;
        let builtin = parse("builtin", BUILTIN, BUILTIN).unwrap();
        let user = parse("user", text, &strip_comments(text)).unwrap();
        let cat = merge(&builtin, Some(&user), Vec::new());
        let node = cat.rules.iter().find(|r| r.id == "node.modules").unwrap();
        assert_eq!(node.safety(), Safety::Caution);
        assert_eq!(node.dirs, ["node_modules"], "unset fields keep the built-in value");
        assert!(!node.custom);
        assert!(!cat.rules.iter().any(|r| r.id == "rust.target"));
        assert_eq!(cat.disabled, 1);
        assert!(cat.rules.iter().find(|r| r.id == "my.cache").unwrap().custom);
        assert_eq!(cat.warnings.len(), 1);
        assert_eq!(cat.warnings[0].line, 7, "points at the broken rule");
    }

    #[test]
    fn editor_check_flags_problems() {
        let text = r#"{
          "version": 2,
          "rulez": [],
          "rules": [
            { "id": "node.modules", "label": "deps" },
            { "id": "rust.target", "disabled": true },
            { "id": "my.x", "type": "location", "paths": ["~/x"], "safety": "safe", "colour": "red" },
            { "id": "my.y", "type": "location", "paths": ["~/y"], "safety": "safe" },
            { "id": "my.y", "label": "again" }
          ]
        }"#;
        let cat = load_text("rules.json", Some(text));
        let msgs: Vec<_> = cat.warnings.iter().map(|w| (w.line, w.message.as_str())).collect();
        assert!(msgs.iter().any(|(l, m)| *l == 3 && m.contains("rulez")), "{msgs:?}");
        assert!(msgs.iter().any(|(l, m)| *l == 2 && m.contains("version")), "{msgs:?}");
        assert!(msgs.iter().any(|(l, m)| *l == 7 && m.contains("colour")), "{msgs:?}");
        assert!(msgs.iter().any(|(_, m)| m.contains("twice")), "{msgs:?}");
        let row = |id: &str| cat.summary.iter().find(|r| r.id == id).unwrap();
        assert!(row("node.modules").overridden && row("node.modules").builtin.is_some());
        assert!(row("rust.target").disabled);
        assert!(row("my.x").custom && row("my.x").broken);
        assert!(!row("ruby.tmp").overridden);
        assert_eq!(cat.summary.len(), cat.rules.len() + cat.disabled + 1);
    }

    #[test]
    fn template_checks_clean() {
        assert!(load_text("rules.json", Some(TEMPLATE)).warnings.is_empty());
    }

    #[test]
    fn syntax_error_has_position() {
        let text = "{\n  \"rules\": [\n    { \"id\": \"x\" \n  ]\n}";
        let err = parse("user", text, &strip_comments(text)).err().unwrap();
        assert_eq!(err.line, 4);
    }

    #[test]
    fn versions() {
        assert_eq!(version_group("WebStorm2024.3"), version_group("WebStorm2025.3"));
        assert_ne!(version_group("chromium-1228"), version_group("chromium_headless_shell-1228"));
        assert!(version_cmp("2.1.295", "2.1.30").is_gt());
        assert!(version_cmp("IntelliJIdea2025.3", "IntelliJIdea2025.2").is_gt());
        assert!(wildcard("AndroidStudio*", "AndroidStudio2024.1"));
        assert!(wildcard("*.avd", "pixel.avd"));
        assert!(!wildcard("*.avd", "pixel.ini"));
    }
}
