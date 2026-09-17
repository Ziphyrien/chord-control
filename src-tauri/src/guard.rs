//! Entry routing and ownership of a revocable desktop/watchdog pair.
#[cfg(windows)]
#[path = "guard/windows.rs"]
mod platform;
#[cfg(windows)]
#[path = "guard/session.rs"]
mod session;

/// Must run before Tauri single-instance handling: maintenance and watchdog are separate roles.
pub(crate) fn handle_cli() -> Result<bool, String> {
    #[cfg(windows)]
    {
        platform::handle_cli()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}
pub(crate) fn start(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::start(app, false)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}
/// Only an explicitly failed in-process update can create a replacement session.
/// Command-line --guard-resume always retains its original, revocable token.
pub(crate) fn restart_after_update(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::start(app, true)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}
pub(crate) fn stop() -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::stop()
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
