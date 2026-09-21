//! Fail packaging early when host metadata and tray-only startup drift apart.
fn main() {
    for path in [
        "tauri.conf.json",
        "tauri.release.conf.json",
        "capabilities/default.json",
        "windows/installer.nsi",
        "windows/hooks.nsh",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("tauri.conf.json"))
        .expect("Invalid desktop configuration");
    assert_eq!(
        config["version"].as_str(),
        Some(env!("CARGO_PKG_VERSION")),
        "Cargo and Tauri versions must match"
    );
    assert_eq!(
        config["identifier"], "com.chord.control",
        "Desktop identity must remain stable"
    );
    let windows = config["app"]["windows"]
        .as_array()
        .expect("Desktop window configuration missing");
    let main = windows
        .iter()
        .find(|window| window["label"] == "main")
        .expect("Main window missing");
    assert_eq!(main["visible"], false, "Startup must remain hidden");
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["installMode"],
        "currentUser"
    );
    assert_eq!(
        config["bundle"]["windows"]["nsis"]["template"],
        "windows/installer.nsi"
    );
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "controller_command",
            "open_data_directory",
            "startup_is_enabled",
            "startup_set_enabled",
        ]),
    ))
    .expect("Desktop build failed");
}
