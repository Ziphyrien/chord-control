use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
}
fn label(id: &str) -> String {
    format!(
        "plugin-{}",
        id.bytes().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn id_from_label(label: &str) -> Option<String> {
    let encoded = label.strip_prefix("plugin-")?;
    if encoded.is_empty()
        || encoded.len() > 200
        || encoded.len() % 2 != 0
        || !encoded.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    let bytes = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|part| u8::from_str_radix(std::str::from_utf8(part).ok()?, 16).ok())
        .collect::<Option<Vec<_>>>()?;
    let id = String::from_utf8(bytes).ok()?;
    valid_id(&id).then_some(id)
}
fn present(app: &AppHandle, value: &serde_json::Value) -> Result<(), String> {
    let id = value["pluginId"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("Invalid plugin ID")?;
    let label = label(id);
    let visible = value["visible"].as_bool().ok_or("Invalid visibility")?;
    if !visible {
        if let Some(window) = app.get_webview_window(&label) {
            window.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let url = value["url"]
        .as_str()
        .ok_or("Plugin URL missing")?
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Plugin URL must be loopback".into());
    }
    let title = value["title"].as_str().unwrap_or("插件");
    if let Some(window) = app.get_webview_window(&label) {
        if window.url().map_err(|e| e.to_string())? != url {
            window.navigate(url).map_err(|e| e.to_string())?;
        }
        window.set_title(title).map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(440.0, 560.0)
        .resizable(false)
        .center()
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn handle(app: &AppHandle, value: &serde_json::Value) {
    let handle = app.clone();
    let value = value.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = present(&handle, &value) {
            crate::desktop::report(&handle, &error);
        }
    }) {
        crate::desktop::report(app, &error.to_string());
    }
}
pub(crate) fn user_closed(app: &AppHandle, label: &str) {
    if let Some(id) = id_from_label(label) {
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
        if id_from_label(&label).is_some() {
            let _ = window.hide();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_are_valid_distinct_and_reversible() {
        for id in ["org.example.widget", "com.a_b", "com.a-b", "com.a.b"] {
            let label = label(id);
            assert!(label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'));
            assert_eq!(id_from_label(&label).as_deref(), Some(id));
        }
        assert_ne!(label("com.a.b"), label("com.a-b"));
    }
    #[test]
    fn malformed_unicode_never_panics() {
        for s in [
            "main",
            "plugin-",
            "plugin-a",
            "plugin-xyz",
            "plugin-€a",
            "plugin-ffff",
            "plugin-00",
        ] {
            assert_eq!(id_from_label(s), None);
        }
    }
}
