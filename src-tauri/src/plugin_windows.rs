//! Plugin windows reuse their webview across page-token changes. Each created window
//! has a unique identity, so asynchronous destruction cannot collide with its successor.
use crate::{controller::Generation, sync::lock};
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub(crate) struct WindowState(Mutex<Windows>);
#[derive(Default)]
struct Windows {
    sequence: u64,
    active: HashMap<String, Window>,
}
#[derive(Clone)]
struct Window {
    label: String,
    generation: Generation,
    url: tauri::Url,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presentation {
    plugin_id: String,
    visible: bool,
    title: Option<String>,
    url: Option<String>,
}
fn next_id(app: &AppHandle) -> Result<u64, String> {
    let state = app.state::<WindowState>();
    let mut windows = lock(&state.0);
    windows.sequence = windows
        .sequence
        .checked_add(1)
        .ok_or("Window sequence exhausted")?;
    Ok(windows.sequence)
}
fn loopback(text: &str) -> Result<tauri::Url, String> {
    let url = text.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Plugin URL must be loopback".into());
    }
    Ok(url)
}
fn retire(app: &AppHandle, id: &str) -> Result<(), String> {
    let previous = lock(&app.state::<WindowState>().0).active.remove(id);
    if let Some(window) = previous.and_then(|entry| app.get_webview_window(&entry.label)) {
        window.hide().map_err(|e| e.to_string())?;
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn present(app: &AppHandle, request: &Presentation, generation: Generation) -> Result<(), String> {
    let previous = lock(&app.state::<WindowState>().0)
        .active
        .get(&request.plugin_id)
        .cloned();
    if !request.visible {
        if let Some(window) = previous
            .filter(|entry| entry.generation == generation)
            .and_then(|entry| app.get_webview_window(&entry.label))
        {
            window.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let url = loopback(request.url.as_deref().ok_or("Plugin URL missing")?)?;
    let title = request.title.as_deref().unwrap_or("插件");
    if title.len() > 256 {
        return Err("Plugin window title too long".into());
    }
    if let Some(entry) = previous
        .filter(|entry| entry.generation == generation && entry.url.origin() == url.origin())
    {
        if let Some(window) = app.get_webview_window(&entry.label) {
            // Revoked page tokens require navigation, not destruction of the native window.
            if window.url().map_err(|e| e.to_string())? != url {
                window.navigate(url.clone()).map_err(|e| e.to_string())?;
            }
            window
                .set_title(title)
                .and_then(|()| window.unminimize())
                .and_then(|()| window.show())
                .and_then(|()| window.set_focus())
                .map_err(|e| e.to_string())?;
            lock(&app.state::<WindowState>().0)
                .active
                .insert(request.plugin_id.clone(), Window { url, ..entry });
            return Ok(());
        }
    }
    retire(app, &request.plugin_id)?;
    if lock(&app.state::<WindowState>().0).active.len() >= 32 {
        return Err("插件窗口数量超出限制".into());
    }
    // Never reuse labels, including while an old webview is still being destroyed.
    let label = format!("plugin-{:x}", next_id(app)?);
    let origin = url.origin();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(title)
        .theme(Some(tauri::Theme::Dark))
        .inner_size(440.0, 560.0)
        .resizable(false)
        .center()
        .focused(true)
        .on_navigation(move |target| target.origin() == origin)
        .build()
        .map_err(|e| e.to_string())?;
    lock(&app.state::<WindowState>().0).active.insert(
        request.plugin_id.clone(),
        Window {
            label,
            generation,
            url,
        },
    );
    Ok(())
}
fn notify_closed(app: &AppHandle, plugin_id: &str, generation: Generation) {
    let result = next_id(app).and_then(|sequence| {
        crate::controller::send_generation(
            app,
            generation,
            serde_json::json!({
                "id": format!("window-closed-{sequence}"),
                "type": "plugin_window_closed",
                "pluginId": plugin_id,
            }),
        )
    });
    if let Err(error) = result {
        eprintln!("Plugin window cancellation discarded: {error}");
    }
}
pub(crate) fn handle(app: &AppHandle, value: &serde_json::Value, generation: Generation) {
    let request = match serde_json::from_value::<Presentation>(value.clone()) {
        Ok(request) if crate::wire::valid_plugin_id(&request.plugin_id) => request,
        _ => {
            crate::desktop::report(app, "插件窗口请求无效");
            return;
        }
    };
    let handle = app.clone();
    let plugin_id = request.plugin_id.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if !crate::lifecycle::is_running(&handle)
            || !crate::controller::is_current(&handle, generation)
        {
            return;
        }
        if let Err(error) = present(&handle, &request, generation) {
            eprintln!("Plugin window presentation failed: {error}");
            let _ = retire(&handle, &request.plugin_id);
            // A presentation event has no RPC reply. End the plugin's pending interaction
            // through its normal close notification instead of leaving it to time out.
            notify_closed(&handle, &request.plugin_id, generation);
            crate::desktop::report(&handle, "插件窗口无法打开，请重试");
        }
    }) {
        eprintln!("Plugin window dispatch failed: {error}");
        notify_closed(app, &plugin_id, generation);
        crate::desktop::report(app, "插件窗口无法打开，请重试");
    }
}
pub(crate) fn user_closed(app: &AppHandle, label: &str) {
    let owner = lock(&app.state::<WindowState>().0)
        .active
        .iter()
        .find(|(_, entry)| entry.label == label)
        .map(|(id, entry)| (id.clone(), entry.generation));
    if let Some((id, generation)) = owner {
        // A delayed close from a retired window cannot cancel a successor's interaction.
        if crate::controller::is_current(app, generation) {
            notify_closed(app, &id, generation);
        }
    }
}
pub(crate) fn hide_all(app: &AppHandle) {
    let active = std::mem::take(&mut lock(&app.state::<WindowState>().0).active);
    for entry in active.into_values() {
        if let Some(window) = app.get_webview_window(&entry.label) {
            let _ = window.hide();
            let _ = window.destroy();
        }
    }
}
