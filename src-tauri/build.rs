fn main() {
    ensure_windows_sidecar_placeholders();
    tauri_build::build()
}

fn ensure_windows_sidecar_placeholders() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let target = match std::env::var("TARGET") {
        Ok(target) => target,
        Err(_) => return,
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let binaries_dir = std::path::Path::new("binaries");

    if let Err(error) = std::fs::create_dir_all(binaries_dir) {
        println!("cargo:warning=failed to create sidecar placeholder directory: {error}");
        return;
    }

    for name in ["ncb-sandbox-setup", "ncb-sandbox-runner"] {
        let paths = [
            binaries_dir.join(format!("{name}-{target}{extension}")),
            binaries_dir.join(format!("{name}{extension}")),
        ];

        for path in paths {
            if path.exists() {
                continue;
            }

            let placeholder = format!(
                "placeholder for {name}; run `npm run prepare:sidecars` before Tauri dev/build\n"
            );

            if let Err(error) = std::fs::write(&path, placeholder) {
                println!(
                    "cargo:warning=failed to create sidecar placeholder '{}': {error}",
                    path.display()
                );
            }
        }
    }
}
