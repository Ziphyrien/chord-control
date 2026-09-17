//! Main-window visibility and generic authorization requests. No plugin policy lives here.
use crate::sync::lock;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

const ACTION_TIMEOUT: Duration = Duration::from_secs(180);
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy)]
pub(crate) enum Action {
    Open,
    Quit,
}
impl Action {
    fn wire(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Quit => "quit",
        }
    }
}
struct Pending {
    id: String,
    action: Action,
    deadline: Instant,
}
#[derive(Default)]
pub(crate) struct DesktopState {
    unlocked: AtomicBool,
    pending: Mutex<Option<Pending>>,
}
impl DesktopState {
    pub fn is_unlocked(&self) -> bool {
        self.unlocked.load(Ordering::Acquire)
    }
    fn cancel(&self, id: &str) -> bool {
        let mut pending = lock(&self.pending);
        if pending.as_ref().is_some_and(|request| request.id == id) {
            *pending = None;
            true
        } else {
            false
        }
    }
}
pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .local_data_dir()
        .map(|root| root.join("ChordControl"))
        .map_err(|e| e.to_string())
}
pub(crate) fn report(app: &AppHandle, message: &str) {
    eprintln!("Desktop: {message}");
    if let Some(tray) = app.tray_by_id("controller") {
        let _ = tray.set_tooltip(Some(format!("Chord Control — {message}")));
    }
    crate::controller::emit(app, json!({"type":"error","message":message}));
}
pub(crate) fn hide_main(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    state.unlocked.store(false, Ordering::Release);
    *lock(&state.pending) = None;
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.hide() {
            report(app, &error.to_string());
        }
    }
}
pub(crate) fn disconnected(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    state.unlocked.store(false, Ordering::Release);
    *lock(&state.pending) = None;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.hide();
        }
        crate::plugin_windows::hide_all(&handle);
    });
}
pub(crate) fn request_action(app: &AppHandle, action: Action) {
    if !crate::lifecycle::is_running(app) {
        return;
    }
    let id = format!(
        "desktop-{}-{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    {
        let state = app.state::<DesktopState>();
        let mut pending = lock(&state.pending);
        if pending
            .as_ref()
            .is_some_and(|request| Instant::now() < request.deadline)
        {
            if let Some(tray) = app.tray_by_id("controller") {
                let _ = tray.set_tooltip(Some("Chord Control — 请完成当前验证"));
            }
            return;
        }
        *pending = Some(Pending {
            id: id.clone(),
            action,
            deadline: Instant::now() + ACTION_TIMEOUT,
        });
    }
    if let Err(error) = crate::controller::start_controller(app).and_then(|()| {
        crate::controller::send_internal(
            app,
            json!({"id":id,"type":"desktop_action","action":action.wire()}),
        )
    }) {
        app.state::<DesktopState>().cancel(&id);
        report(app, &error);
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACTION_TIMEOUT).await;
        if handle.state::<DesktopState>().cancel(&id) {
            report(&handle, "桌面操作等待超时，请重新操作");
        }
    });
}
pub(crate) fn handle_event(
    app: &AppHandle,
    value: &Value,
    generation: crate::controller::Generation,
) {
    if !crate::lifecycle::is_running(app) {
        return;
    }
    if value["type"] == "plugin_window" {
        crate::plugin_windows::handle(app, value, generation);
        return;
    }
    if value["type"] != "response" {
        return;
    }
    let Some(id) = value["id"].as_str() else {
        return;
    };
    if !lock(&app.state::<DesktopState>().pending)
        .as_ref()
        .is_some_and(|request| request.id == id)
    {
        return;
    }
    let handle = app.clone();
    let value = value.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if !crate::controller::is_current(&handle, generation)
            || !crate::lifecycle::is_running(&handle)
        {
            return;
        }
        let state = handle.state::<DesktopState>();
        let request = {
            let mut pending = lock(&state.pending);
            if !pending
                .as_ref()
                .is_some_and(|request| value["id"] == request.id)
            {
                return;
            }
            pending
                .take()
                .filter(|request| Instant::now() < request.deadline)
        };
        let Some(request) = request else {
            return;
        };
        if value["ok"] != true {
            report(&handle, value["message"].as_str().unwrap_or("操作未获允许"));
            return;
        }
        match request.action {
            Action::Quit => crate::lifecycle::quit(&handle),
            Action::Open => {
                if let Some(window) = handle.get_webview_window("main") {
                    match window
                        .unminimize()
                        .and_then(|()| window.show())
                        .and_then(|()| window.set_focus())
                    {
                        Ok(()) => {
                            state.unlocked.store(true, Ordering::Release);
                        }
                        Err(error) => {
                            let _ = window.hide();
                            report(&handle, &error.to_string());
                        }
                    }
                }
            }
        }
    }) {
        report(app, &error.to_string());
    }
}
/// Custom application commands also verify their caller; plugin webviews cannot borrow
/// the main window's unlocked state even if they attempt to invoke an app command.
pub(crate) fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此操作仅可在控制中心使用".into());
    }
    let url = window.url().map_err(|error| error.to_string())?;
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && window
            .app_handle()
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|configured| configured.origin() == url.origin());
    if bundled || development {
        Ok(())
    } else {
        Err("请从本地控制中心执行此操作".into())
    }
}
#[tauri::command]
pub(crate) fn open_data_directory(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    require_main(&window)?;
    if !state.is_unlocked() || !crate::lifecycle::is_running(&app) {
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
    let directory = data_dir(app)?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let marker = directory.join("first-run-complete");
    if marker.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    app.autolaunch().enable().map_err(|e| e.to_string())?;
    fs::write(marker, b"1").map_err(|e| e.to_string())
}
