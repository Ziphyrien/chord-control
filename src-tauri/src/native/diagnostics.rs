//! Read-only host diagnostics; plugin policy remains outside the native host.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

fn outcome(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

pub(super) fn snapshot(app: &AppHandle) -> Value {
    json!({
        "version": app.package_info().version.to_string(),
        "pid": std::process::id(),
        "unlocked": app.state::<crate::desktop::DesktopState>().is_unlocked(),
        "autostart": outcome(app.autolaunch().is_enabled().map(Value::Bool).map_err(|e| e.to_string())),
        "updater": crate::updater::status(app),
    })
}
