use crate::desktop::request_action;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

pub(crate) fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "打开控制中心", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "启动离线控制器", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "quit", "退出控制器", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &exit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("Missing app icon"))?;
    TrayIconBuilder::with_id("controller")
        .icon(icon)
        .tooltip("Chord Control")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => request_action(app, "open"),
            "restart" => request_action(app, "open"),
            "quit" => request_action(app, "quit"),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                request_action(tray.app_handle(), "open");
            }
        })
        .build(app)?;
    Ok(())
}
