//! Stable desktop primitives. API composition and policy live in replaceable Chord services.
mod visibility;
use crate::{controller::Generation, sync::lock};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Manager};
use visibility::Visibility;

const OPERATIONS: &[&str] = &[
    "info",
    "window.state",
    "window.open",
    "window.hide",
    "window.minimize",
    "window.taskbar",
    "tray.visible",
    "updates.status",
    "updates.check",
    "updates.install",
    "app.quit",
];
#[derive(Clone)]
struct Session {
    plugin: String,
    generation: Generation,
    visibility: Visibility,
}
#[derive(Default)]
pub(crate) struct KernelState(Mutex<HashMap<String, Session>>);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scope {
    session: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    session: String,
    operation: String,
    input: Value,
}
fn decode<T: serde::de::DeserializeOwned>(input: &Value) -> Result<T, String> {
    serde_json::from_value(input.clone()).map_err(|e| e.to_string())
}
fn visibility(sessions: &HashMap<String, Session>) -> (bool, bool) {
    Visibility::combined(sessions.values().map(|session| &session.visibility))
}
fn apply(app: &AppHandle, visible: (bool, bool)) -> Result<(), String> {
    let tray = app.tray_by_id("controller").ok_or("托盘不可用")?;
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    tray.set_visible(visible.0).map_err(|e| e.to_string())?;
    window.set_skip_taskbar(!visible.1).map_err(|e| e.to_string())
}
fn owned<'a>(
    sessions: &'a mut HashMap<String, Session>,
    id: &str,
    plugin: &str,
    generation: Generation,
) -> Result<&'a mut Session, String> {
    sessions
        .get_mut(id)
        .filter(|s| s.plugin == plugin && s.generation == generation)
        .ok_or_else(|| "API 会话已释放或不属于此插件".into())
}
// Executed only on the event-loop thread, preserving open/call/close wire order.
pub(crate) fn execute(
    app: &AppHandle,
    generation: Generation,
    plugin: &str,
    operation: &str,
    input: &Value,
) -> Result<Value, String> {
    let state = app.state::<KernelState>();
    if operation == "host.close" {
        let scope: Scope = decode(input)?;
        let mut sessions = lock(&state.0);
        if !sessions.contains_key(&scope.session) {
            return Ok(Value::Null);
        }
        owned(&mut sessions, &scope.session, plugin, generation)?;
        sessions.remove(&scope.session);
        apply(app, visibility(&sessions))?;
        return Ok(Value::Null);
    }
    if !crate::lifecycle::is_running(app) {
        return Err("程序正在退出或更新".into());
    }
    if operation == "host.open" {
        let scope: Scope = decode(input)?;
        if scope.session.is_empty()
            || scope.session.len() > 100
            || !scope
                .session
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("无效 API 会话".into());
        }
        let mut sessions = lock(&state.0);
        if sessions.contains_key(&scope.session) {
            owned(&mut sessions, &scope.session, plugin, generation)?;
        } else {
            if sessions.len() >= 256 {
                return Err("API 会话数量超出限制".into());
            }
            sessions.insert(
                scope.session,
                Session {
                    plugin: plugin.into(),
                    generation,
                    visibility: Visibility::default(),
                },
            );
        }
        return Ok(Value::Null);
    }
    if operation != "host.call" {
        return Err("未知 API 会话操作".into());
    }
    let call: Call = decode(input)?;
    {
        let mut sessions = lock(&state.0);
        owned(&mut sessions, &call.session, plugin, generation)?;
        if call.operation == "tray.visible" || call.operation == "window.taskbar" {
            let visible = call.input.as_bool().ok_or("可见状态必须是布尔值")?;
            let before = sessions.clone();
            let session = owned(&mut sessions, &call.session, plugin, generation)?;
            if call.operation == "tray.visible" {
                session.visibility.tray_hidden = !visible;
            } else {
                session.visibility.taskbar_hidden = !visible;
            }
            if let Err(error) = apply(app, visibility(&sessions)) {
                *sessions = before;
                let _ = apply(app, visibility(&sessions));
                return Err(error);
            }
            return Ok(Value::Null);
        }
    }
    if !call.input.is_null() {
        return Err("此操作不接受参数".into());
    }
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    match call.operation.as_str() {
        "info" => {
            #[cfg(windows)]
            let hwnd = Some(format!(
                "{}",
                window.hwnd().map_err(|e| e.to_string())?.0 as usize
            ));
            #[cfg(not(windows))]
            let hwnd: Option<String> = None;
            Ok(json!({"protocol":1,"hostVersion":app.package_info().version.to_string(),
                "platform":std::env::consts::OS,"operations":OPERATIONS,"mainWindowHandle":hwnd,
                "executable":std::env::current_exe().map_err(|e|e.to_string())?,
                "pid":std::process::id()}))
        }
        "window.state" => {
            let visible = visibility(&lock(&state.0));
            Ok(json!({"visible":window.is_visible().map_err(|e|e.to_string())?,
                "minimized":window.is_minimized().map_err(|e|e.to_string())?,
                "trayVisible":visible.0,"taskbarVisible":visible.1}))
        }
        "window.open" => {
            crate::desktop::request_action(app, crate::desktop::Action::Open);
            Ok(Value::Null)
        }
        "window.hide" => {
            crate::desktop::hide_main(app);
            Ok(Value::Null)
        }
        "window.minimize" => window
            .minimize()
            .map(|()| Value::Null)
            .map_err(|e| e.to_string()),
        "app.quit" => {
            crate::desktop::request_action(app, crate::desktop::Action::Quit);
            Ok(Value::Null)
        }
        "updates.status" => Ok(crate::updater::status(app)),
        "updates.check" => crate::updater::request_plugin(app, false),
        "updates.install" => crate::updater::request_plugin(app, true),
        _ => Err(format!("宿主不支持操作: {}", call.operation)),
    }
}
pub(crate) fn retire(app: &AppHandle, generation: Generation) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let state = handle.state::<KernelState>();
        let mut sessions = lock(&state.0);
        sessions.retain(|_, session| session.generation != generation);
        if let Err(error) = apply(&handle, visibility(&sessions)) {
            crate::desktop::report(&handle, &format!("恢复桌面入口失败: {error}"));
        }
    }) {
        crate::desktop::report(app, &error.to_string());
    }
}
