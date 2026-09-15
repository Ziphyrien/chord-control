use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

#[derive(Default)]
pub(crate) struct DesktopState {
    pub unlocked: AtomicBool,
    pending: Mutex<Option<(String, String)>>,
}
pub(crate) fn data_dir() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok(PathBuf::from(root).join("ChordControl"))
}
fn show_main(app: &AppHandle) {
    app.state::<DesktopState>()
        .unlocked
        .store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub(crate) fn lock(app: &AppHandle) {
    app.state::<DesktopState>()
        .unlocked
        .store(false, Ordering::SeqCst);
}
pub(crate) fn disconnected(app: &AppHandle) {
    lock(app);
    if let Ok(mut pending) = app.state::<DesktopState>().pending.lock() {
        pending.take();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}
pub(crate) fn request_action(app: &AppHandle, action: &str) {
    let request_id = format!(
        "desktop-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let state = app.state::<DesktopState>();
    if let Ok(mut pending) = state.pending.lock() {
        if pending.is_some() {
            return;
        }
        *pending = Some((request_id.clone(), action.to_owned()));
    } else {
        return;
    }
    if let Err(error) = crate::controller::start_controller(app).and_then(|()| {
        crate::controller::send_internal(
            app,
            serde_json::json!({"id":request_id,"type":"desktop_action","action":action}),
        )
    }) {
        if let Ok(mut pending) = state.pending.lock() {
            pending.take();
        }
        crate::controller::emit(app, serde_json::json!({"type":"error","message":error}));
    }
}
pub(crate) fn handle_event(app: &AppHandle, value: &serde_json::Value) {
    if value["type"] == "plugin_window" {
        if let Err(error) = present_plugin(app, value) {
            crate::controller::emit(app, serde_json::json!({"type":"error","message":error}));
        }
        return;
    }
    if value["type"] != "response" {
        return;
    }
    let state = app.state::<DesktopState>();
    let action = if let Ok(mut pending) = state.pending.lock() {
        if pending
            .as_ref()
            .is_some_and(|(id, _)| value["id"].as_str() == Some(id.as_str()))
        {
            pending.take().map(|(_, action)| action)
        } else {
            None
        }
    } else {
        None
    };
    if let Some(action) = action {
        if value["ok"] == true {
            if action == "open" {
                show_main(app);
            } else if action == "quit" {
                crate::controller::quit(app);
            }
        } else if let Some(tray) = app.tray_by_id("controller") {
            let _ = tray.set_tooltip(Some(format!(
                "Chord Control — {}",
                value["message"].as_str().unwrap_or("操作未获允许")
            )));
        }
    }
}
fn present_plugin(app: &AppHandle, value: &serde_json::Value) -> Result<(), String> {
    let id = value["pluginId"].as_str().ok_or("Plugin ID missing")?;
    if id.len() > 100
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
    {
        return Err("Invalid plugin ID".into());
    }
    let label = format!("plugin-{id}");
    if value["visible"] != true {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let url = value["url"]
        .as_str()
        .ok_or("Plugin URL missing")?
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Plugin URL must be loopback".into());
    }
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(value["title"].as_str().unwrap_or("插件"))
        .inner_size(440.0, 560.0)
        .resizable(false)
        .center()
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn window_closed(app: &AppHandle, label: &str) {
    if let Some(id) = label.strip_prefix("plugin-") {
        let _ = crate::controller::send_internal(
            app,
            serde_json::json!({"id":format!("closed-{id}"),"type":"plugin_window_closed","pluginId":id}),
        );
    }
}
#[tauri::command]
pub(crate) fn open_data_directory(state: State<'_, DesktopState>) -> Result<(), String> {
    if !state.unlocked.load(Ordering::SeqCst) {
        return Err("控制中心尚未解锁".into());
    }
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer.exe")
        .arg(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn ensure_autostart(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let marker = dir.join("first-run-complete");
    if !marker.exists() {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
        fs::write(marker, b"1").map_err(|e| e.to_string())?;
    }
    Ok(())
}
