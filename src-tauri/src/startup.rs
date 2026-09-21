//! One source of truth for the login setting: a same-user interactive highest task.
#[cfg(windows)]
mod policy;
#[cfg(windows)]
mod task;
use tauri::{AppHandle, Manager};

pub(crate) fn is_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    {
        task::request("query")
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}
pub(crate) fn ensure() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        task::request("ensure").map(|_| ())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
pub(crate) fn remove() -> Result<(), String> {
    #[cfg(windows)]
    {
        task::request("remove").map(|_| ())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
pub(crate) fn handle_cli() -> Result<bool, String> {
    #[cfg(windows)]
    {
        task::handle_cli()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}
#[tauri::command]
pub(crate) async fn startup_is_enabled(window: tauri::WebviewWindow) -> Result<bool, String> {
    crate::desktop::require_main(&window)?;
    // Read-only status also runs while the hidden main webview is attaching.
    tauri::async_runtime::spawn_blocking(is_enabled)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn startup_set_enabled(
    app: AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<bool, String> {
    crate::desktop::require_main(&window)?;
    if !app.state::<crate::desktop::DesktopState>().is_unlocked()
        || !crate::lifecycle::is_running(&app)
    {
        return Err("控制中心尚未解锁".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !app.state::<crate::desktop::DesktopState>().is_unlocked()
            || !crate::lifecycle::is_running(&app)
        {
            return Err("控制中心尚未解锁".into());
        }
        #[cfg(windows)]
        {
            task::request(if enabled { "enable" } else { "disable" })
        }
        #[cfg(not(windows))]
        {
            let _ = enabled;
            Err("启动设置仅支持 Windows".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
