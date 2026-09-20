//! Desktop composition root. All plugin-specific behavior belongs to the sidecar/plugins.
mod controller;
mod desktop;
mod guard;
mod kernel;
mod lifecycle;
mod logging;
mod native;
mod plugin_windows;
#[cfg(windows)]
mod shell_launch;
mod sync;
mod tray;
mod updater;
mod wire;
use tauri::{Manager, WindowEvent};

/// CLI roles return before creating windows or entering single-instance handling.
/// Startup failures are returned to the executable so they cannot bypass guard cleanup.
pub fn run() -> Result<(), String> {
    if guard::handle_cli().inspect_err(|error| {
        updater::diagnostics::record("cli_failed", None, serde_json::json!({"error": error}));
    })? {
        return Ok(());
    }
    updater::diagnostics::record("startup_started", None, serde_json::json!({}));
    let app = tauri::Builder::default()
        // A second launch cannot unlock/show the existing main window or invoke a hook.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Chord Control")
                .args(["--background"])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(controller::ControllerState::default())
        .manage(desktop::DesktopState::default())
        .manage(lifecycle::Lifecycle::default())
        .manage(native::NativeState::default())
        .manage(kernel::KernelState::default())
        .manage(plugin_windows::WindowState::default())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            controller::controller_command,
            desktop::open_data_directory
        ])
        .setup(|app| {
            // Resume validation must precede autostart, updater and controller side effects.
            guard::start(app.handle()).map_err(std::io::Error::other)?;
            desktop::hide_main(app.handle());
            tray::setup(app)?;
            if let Err(error) = desktop::ensure_autostart(app.handle()) {
                desktop::report(app.handle(), &error);
            }
            let controller = controller::start_controller(app.handle());
            if let Err(error) = &controller {
                desktop::report(app.handle(), error);
            }
            updater::diagnostics::record(
                "startup_ready",
                None,
                serde_json::json!({
                    "controller_started": controller.is_ok(), "controller_error": controller.err()
                }),
            );
            updater::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    desktop::hide_main(window.app_handle());
                } else {
                    let _ = window.hide();
                    plugin_windows::user_closed(window.app_handle(), window.label());
                }
            }
        })
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => lifecycle::exit_requested(app, &api),
            tauri::RunEvent::Exit => {
                updater::diagnostics::record("event_loop_exit", None, serde_json::json!({}));
                lifecycle::final_cleanup(app);
                updater::diagnostics::record("cleanup_finished", None, serde_json::json!({}));
            }
            _ => {}
        }),
        Err(error) => {
            updater::diagnostics::record(
                "startup_failed",
                None,
                serde_json::json!({"error": error.to_string()}),
            );
            let _ = guard::stop();
            return Err(error.to_string());
        }
    }
    Ok(())
}
