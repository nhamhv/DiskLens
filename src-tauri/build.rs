//! Besides the Tauri build, passes `APTABASE_APP_KEY` / `APTABASE_HOST` to the compiler. They come
//! from the environment (CI) or from an untracked `.env` file at the repo root (see `.env.example`).

fn main() {
    println!("cargo:rerun-if-changed=../.env");
    let file = std::fs::read_to_string("../.env").unwrap_or_default();
    for name in ["APTABASE_APP_KEY", "APTABASE_HOST"] {
        println!("cargo:rerun-if-env-changed={name}");
        let from_file = file.lines().find_map(|l| l.trim().strip_prefix(name)?.trim_start().strip_prefix('=')).map(|v| v.trim().trim_matches('"').to_string());
        if let Some(value) = std::env::var(name).ok().or(from_file).filter(|v| !v.is_empty()) {
            println!("cargo:rustc-env={name}={value}");
        }
    }
    tauri_build::build()
}
