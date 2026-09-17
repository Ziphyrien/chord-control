//! Unprivileged plugin webviews. Window identity is reversible and generation-bound.
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Presentation {
    plugin_id: String,
    visible: bool,
    title: Option<String>,
    url: Option<String>,
}
fn label(id: &str) -> String {
    use std::fmt::Write;
    let mut label = String::from("plugin-");
    for byte in id.bytes() {
        let _ = write!(label, "{byte:02x}");
    }
    label
}
fn plugin_id(label: &str) -> Option<String> {
    let encoded = label.strip_prefix("plugin-")?;
    if encoded.is_empty()
        || encoded.len() > 200
        || encoded.len() % 2 != 0
        || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let bytes = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect::<Option<Vec<_>>>()?;
    let id = String::from_utf8(bytes).ok()?;
    crate::wire::valid_plugin_id(&id).then_some(id)
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
fn present(app: &AppHandle, value: &serde_json::Value) -> Result<(), String> {
    let request: Presentation = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    if !crate::wire::valid_plugin_id(&request.plugin_id) {
        return Err("Invalid plugin ID".into());
    }
    let label = label(&request.plugin_id);
    let existing = app.get_webview_window(&label);
    if !request.visible {
        if let Some(window) = existing {
            window.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let url = loopback(request.url.as_deref().ok_or("Plugin URL missing")?)?;
    let title = request.title.as_deref().unwrap_or("插件");
    if title.len() > 256 {
        return Err("Plugin window title too long".into());
    }
    if let Some(window) = existing {
        if window.url().map_err(|e| e.to_string())? == url {
            window
                .set_title(title)
                .and_then(|()| window.unminimize())
                .and_then(|()| window.show())
                .and_then(|()| window.set_focus())
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        // Recreate when the server/token changes so navigation guards use the new origin.
        window.destroy().map_err(|e| e.to_string())?;
    }
    if app
        .webview_windows()
        .keys()
        .filter(|label| plugin_id(label).is_some())
        .count()
        >= 32
    {
        return Err("插件窗口数量超出限制".into());
    }
    let origin = url.origin();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(440.0, 560.0)
        .resizable(false)
        .center()
        .focused(true)
        .on_navigation(move |target| target.origin() == origin)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn handle(
    app: &AppHandle,
    value: &serde_json::Value,
    generation: crate::controller::Generation,
) {
    let handle = app.clone();
    let value = value.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if !crate::lifecycle::is_running(&handle)
            || !crate::controller::is_current(&handle, generation)
        {
            return;
        }
        if let Err(error) = present(&handle, &value) {
            crate::desktop::report(&handle, &error);
        }
    }) {
        crate::desktop::report(app, &error.to_string());
    }
}
pub(crate) fn user_closed(app: &AppHandle, label: &str) {
    if let Some(id) = plugin_id(label) {
        if let Err(error) = crate::controller::send_internal(
            app,
            serde_json::json!({"id":format!("closed-{id}"),"type":"plugin_window_closed","pluginId":id}),
        ) {
            crate::desktop::report(app, &error);
        }
    }
}
pub(crate) fn hide_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if plugin_id(&label).is_some() {
            let _ = window.hide();
            let _ = window.destroy();
        }
    }
}
