mod controller;
mod desktop;
mod tray;

use tauri::WindowEvent;

pub fn run() {
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
        .manage(controller::ControllerState::default())
        .manage(desktop::DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            controller::controller_command,
            desktop::open_data_directory
        ])
        .setup(|app| {
            desktop::ensure_autostart(app.handle()).map_err(std::io::Error::other)?;
            tray::setup(app)?;
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
                    desktop::request_action(window.managed_app_handle(), "quit");
                }
            } else if let WindowEvent::Destroyed = event {
                desktop::window_closed(window.managed_app_handle(), window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize Chord Control")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                controller::kill(app);
            }
        });
}
