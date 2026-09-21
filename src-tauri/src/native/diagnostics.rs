//! Read-only host diagnostics; plugin policy remains outside the native host.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn outcome(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

pub(super) fn process_identity() -> Value {
    #[cfg(windows)]
    {
        use super::process;
        use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
        match process::open(std::process::id(), PROCESS_QUERY_LIMITED_INFORMATION)
            .and_then(|handle| process::identity(&handle))
        {
            Ok((_, created_at)) => json!({"pid":std::process::id(),"createdAt":created_at}),
            Err(error) => json!({"pid":std::process::id(),"error":error}),
        }
    }
    #[cfg(not(windows))]
    {
        json!({"pid":std::process::id(),"error":"Windows process identity unavailable"})
    }
}

pub(super) fn snapshot(app: &AppHandle) -> Value {
    json!({
        "schemaVersion": 2,
        "observedAtMs": super::failures::now_ms(),
        "process": process_identity(),
        "failures": crate::sync::lock(&app.state::<super::NativeState>().failures).snapshot(),
        "version": app.package_info().version.to_string(),
        "pid": std::process::id(),
        "unlocked": app.state::<crate::desktop::DesktopState>().is_unlocked(),
        "autostart": outcome(crate::startup::is_enabled().map(Value::Bool)),
        "updater": crate::updater::status(app),
    })
}
