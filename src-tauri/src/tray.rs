//! Tray actions are adapters to application services, never authorization decisions.
use crate::desktop::{request_action, Action};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
fn dispatch(app: &tauri::AppHandle, id: &str) {
    match id {
        "show" | "restart" => request_action(app, Action::Open),
        "quit" => request_action(app, Action::Quit),
        "update" => crate::updater::request(app),
        _ => {}
    }
}
pub(crate) fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let entries = [
        ("show", "打开控制中心"),
        ("restart", "重新连接"),
        ("update", "检查并安装主程序更新"),
        ("quit", "退出控制器"),
    ]
    .into_iter()
    .map(|(id, text)| MenuItem::with_id(app, id, text, true, None::<&str>))
    .collect::<Result<Vec<_>, _>>()?;
    let menu = Menu::new(app)?;
    for entry in &entries {
        menu.append(entry)?;
    }
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::other("Missing tray icon"))?;
    TrayIconBuilder::with_id("controller")
        .icon(icon)
        .tooltip("Chord Control")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| dispatch(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                request_action(tray.app_handle(), Action::Open);
            }
        })
        .build(app)?;
    Ok(())
}
