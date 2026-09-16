mod controller;
mod desktop;
mod guard;
mod native;
mod plugin_windows;
mod sync;
mod tray;
mod updater;

use tauri::{Manager, WindowEvent};

pub fn run() {
    if guard::handle_cli() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == "--background") {
                desktop::request_action(app, "open");
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Chord Control")
                .args(["--background"])
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(controller::ControllerState::default())
        .manage(desktop::DesktopState::default())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            controller::controller_command,
            desktop::open_data_directory
        ])
        .setup(|app| {
            desktop::ensure_autostart(app.handle()).map_err(std::io::Error::other)?;
            tray::setup(app)?;
            guard::start(app.handle())?;
            updater::start(app.handle());
            if let Err(error) = controller::start_controller(app.handle()) {
                controller::emit(
                    app.handle(),
                    serde_json::json!({"type":"error","message":error}),
                );
            }
            if !std::env::args().any(|arg| arg == "--background") {
                desktop::request_action(app.handle(), "open");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    desktop::request_action(window.app_handle(), "quit");
                }
            } else if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                plugin_windows::user_closed(window.app_handle(), window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize Chord Control")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                guard::stop();
                controller::kill(app);
            }
        });
}
