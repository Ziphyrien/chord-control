use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;
const ACTION_TIMEOUT: Duration = Duration::from_secs(180);
struct Request {
    id: String,
    action: String,
    started: Instant,
}
#[derive(Default)]
struct Pending(Option<Request>);
impl Pending {
    fn begin(&mut self, id: String, action: String, now: Instant) -> bool {
        if self
            .0
            .as_ref()
            .is_some_and(|r| now.duration_since(r.started) < ACTION_TIMEOUT)
        {
            return false;
        }
        self.0 = Some(Request {
            id,
            action,
            started: now,
        });
        true
    }
    fn take(&mut self, id: &str, now: Instant) -> Option<String> {
        if !self.0.as_ref().is_some_and(|r| r.id == id) {
            return None;
        }
        self.0
            .take()
            .filter(|r| now.duration_since(r.started) < ACTION_TIMEOUT)
            .map(|r| r.action)
    }
    fn cancel(&mut self, id: &str) -> bool {
        if self.0.as_ref().is_some_and(|r| r.id == id) {
            self.0 = None;
            true
        } else {
            false
        }
    }
}
#[derive(Default)]
pub(crate) struct DesktopState {
    pub unlocked: AtomicBool,
    pending: Mutex<Pending>,
}
pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Preserve the existing data location while resolving it through the Windows known folder API.
    app.path()
        .local_data_dir()
        .map(|base| base.join("ChordControl"))
        .map_err(|e| e.to_string())
}
pub(crate) fn report(app: &AppHandle, error: &str) {
    eprintln!("Desktop: {error}");
    if let Some(tray) = app.tray_by_id("controller") {
        let _ = tray.set_tooltip(Some(format!("Chord Control — {error}")));
    }
    crate::controller::emit(app, serde_json::json!({"type":"error","message":error}));
}
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus())
        {
            Ok(()) => {
                app.state::<DesktopState>()
                    .unlocked
                    .store(true, Ordering::SeqCst);
            }
            Err(error) => report(app, &error.to_string()),
        }
    }
}
pub(crate) fn disconnected(app: &AppHandle) {
    app.state::<DesktopState>()
        .unlocked
        .store(false, Ordering::SeqCst);
    crate::sync::lock(&app.state::<DesktopState>().pending).0 = None;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    crate::plugin_windows::hide_all(app);
}
pub(crate) fn request_action(app: &AppHandle, action: &str) {
    if !["open", "quit"].contains(&action) {
        report(app, "未知桌面操作");
        return;
    }
    let id = format!(
        "desktop-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    if !crate::sync::lock(&app.state::<DesktopState>().pending).begin(
        id.clone(),
        action.to_owned(),
        Instant::now(),
    ) {
        if let Some(tray) = app.tray_by_id("controller") {
            let _ = tray.set_tooltip(Some("Chord Control — 请完成当前验证"));
        }
        return;
    }
    if let Err(error) = crate::controller::start_controller(app).and_then(|()| {
        crate::controller::send_internal(
            app,
            serde_json::json!({"id":id,"type":"desktop_action","action":action}),
        )
    }) {
        crate::sync::lock(&app.state::<DesktopState>().pending).cancel(&id);
        report(app, &error);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACTION_TIMEOUT).await;
        if crate::sync::lock(&app.state::<DesktopState>().pending).cancel(&id) {
            report(&app, "桌面操作等待超时，请重新操作");
        }
    });
}
pub(crate) fn handle_event(app: &AppHandle, value: &serde_json::Value) {
    if value["type"] == "plugin_window" {
        crate::plugin_windows::handle(app, value);
        return;
    }
    if value["type"] != "response" {
        return;
    }
    let action = crate::sync::lock(&app.state::<DesktopState>().pending)
        .take(value["id"].as_str().unwrap_or(""), Instant::now());
    if let Some(action) = action {
        if value["ok"] == true {
            if action == "open" {
                show_main(app);
            } else {
                crate::controller::quit(app);
            }
        } else {
            report(app, value["message"].as_str().unwrap_or("操作未获允许"));
        }
    }
}
#[tauri::command]
pub(crate) fn open_data_directory(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    if !state.unlocked.load(Ordering::SeqCst) {
        return Err("控制中心尚未解锁".into());
    }
    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
pub(crate) fn ensure_autostart(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let dir = data_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let marker = dir.join("first-run-complete");
    if !marker.exists() {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
        fs::write(marker, b"1").map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_expires_and_late_reply_cannot_complete_new_action() {
        let mut pending = Pending::default();
        let now = Instant::now();
        assert!(pending.begin("a".into(), "open".into(), now));
        assert!(!pending.begin("b".into(), "quit".into(), now + Duration::from_secs(5)));
        assert!(pending.begin("b".into(), "quit".into(), now + ACTION_TIMEOUT));
        assert_eq!(pending.take("a", now + ACTION_TIMEOUT), None);
        assert!(!pending.cancel("a"));
        assert_eq!(
            pending.take("b", now + ACTION_TIMEOUT).as_deref(),
            Some("quit")
        );
    }
}
