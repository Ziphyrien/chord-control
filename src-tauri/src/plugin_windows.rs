//! Plugin windows reuse their webview, unload revoked pages while hidden and only
//! reveal the current document after it finishes loading. Labels are never reused.
use crate::{controller::Generation, sync::lock};
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{webview::PageLoadEvent, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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
    visible: bool,
    ready: bool,
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
fn hide(app: &AppHandle, id: &str, generation: Generation) -> Result<(), String> {
    let label = {
        let state = app.state::<WindowState>();
        let mut windows = lock(&state.0);
        windows
            .active
            .get_mut(id)
            .filter(|entry| entry.generation == generation)
            .map(|entry| {
                entry.visible = false;
                entry.ready = false;
                entry.label.clone()
            })
    };
    if let Some(window) = label.and_then(|label| app.get_webview_window(&label)) {
        window.hide().map_err(|e| e.to_string())?;
        // Hiding a native window alone does not unload its document or stop polling.
        window
            .navigate(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn reveal(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
        .map_err(|e| e.to_string())
}
fn same_document(expected: &tauri::Url, loaded: &tauri::Url) -> bool {
    let mut expected = expected.clone();
    let mut loaded = loaded.clone();
    expected.set_fragment(None);
    loaded.set_fragment(None);
    expected == loaded
}
fn page_loaded(app: &AppHandle, label: &str, url: &tauri::Url) {
    if !crate::lifecycle::is_running(app) {
        return;
    }
    let owner = {
        let state = app.state::<WindowState>();
        let mut windows = lock(&state.0);
        windows
            .active
            .iter_mut()
            .find(|(_, entry)| {
                entry.label == label
                    && entry.visible
                    && !entry.ready
                    && same_document(&entry.url, url)
            })
            .map(|(id, entry)| {
                entry.ready = true;
                (id.clone(), entry.generation)
            })
    };
    if let Some((id, generation)) = owner {
        if !crate::controller::is_current(app, generation) {
            return;
        }
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = reveal(&window) {
                presentation_failed(app, &id, generation, &error);
            }
        }
    }
}
fn present(app: &AppHandle, request: &Presentation, generation: Generation) -> Result<(), String> {
    if !request.visible {
        return hide(app, &request.plugin_id, generation);
    }
    let previous = lock(&app.state::<WindowState>().0)
        .active
        .get(&request.plugin_id)
        .cloned();
    let url = loopback(request.url.as_deref().ok_or("Plugin URL missing")?)?;
    let title = request.title.as_deref().unwrap_or("插件");
    if title.len() > 256 {
        return Err("Plugin window title too long".into());
    }
    if let Some(entry) = previous
        .filter(|entry| entry.generation == generation && entry.url.origin() == url.origin())
    {
        if let Some(window) = app.get_webview_window(&entry.label) {
            window.set_title(title).map_err(|e| e.to_string())?;
            if entry.visible && entry.ready && entry.url == url {
                return reveal(&window);
            }
            // Never expose the previous document while navigate is still asynchronous.
            window.hide().map_err(|e| e.to_string())?;
            lock(&app.state::<WindowState>().0).active.insert(
                request.plugin_id.clone(),
                Window {
                    url: url.clone(),
                    visible: true,
                    ready: false,
                    ..entry
                },
            );
            window.navigate(url).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    retire(app, &request.plugin_id)?;
    if lock(&app.state::<WindowState>().0).active.len() >= 32 {
        return Err("插件窗口数量超出限制".into());
    }
    let label = format!("plugin-{:x}", next_id(app)?);
    let origin = url.origin();
    // Register intent before build: a fast page load may complete during creation.
    lock(&app.state::<WindowState>().0).active.insert(
        request.plugin_id.clone(),
        Window {
            label: label.clone(),
            generation,
            url: url.clone(),
            visible: true,
            ready: false,
        },
    );
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .theme(Some(tauri::Theme::Dark))
        .inner_size(440.0, 560.0)
        .resizable(false)
        .center()
        .visible(false)
        .focused(false)
        .on_navigation(move |target| target.as_str() == "about:blank" || target.origin() == origin)
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let handle = window.app_handle().clone();
            let app = handle.clone();
            let label = window.label().to_owned();
            let url = payload.url().clone();
            if let Err(error) = handle.run_on_main_thread(move || page_loaded(&app, &label, &url)) {
                eprintln!("Plugin page readiness discarded: {error}");
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn notify_closed(app: &AppHandle, plugin_id: &str, generation: Generation) {
    let result = next_id(app).and_then(|sequence| {
        crate::controller::send_generation(
            app,
            generation,
            serde_json::json!({
                "id": format!("window-closed-{sequence}"),
                "type": "plugin_window_closed", "pluginId": plugin_id,
            }),
        )
    });
    if let Err(error) = result {
        eprintln!("Plugin window cancellation discarded: {error}");
    }
}
fn presentation_failed(app: &AppHandle, id: &str, generation: Generation, error: &str) {
    eprintln!("Plugin window presentation failed: {error}");
    let _ = retire(app, id);
    notify_closed(app, id, generation);
    crate::desktop::report(app, "插件窗口无法打开，请重试");
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
            presentation_failed(&handle, &request.plugin_id, generation, &error);
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
        if crate::controller::is_current(app, generation) {
            // Clear visibility immediately so a late load cannot reopen a closed window.
            if let Err(error) = hide(app, &id, generation) {
                eprintln!("Plugin page cleanup failed: {error}");
                let _ = retire(app, &id);
            }
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
