#[cfg(windows)]
pub(crate) mod process;
#[cfg(windows)]
mod registry;
#[cfg(windows)]
mod wallpaper;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    plugin_id: String,
    permission: String,
    operation: String,
    input: Value,
}
fn execute(request: &Request) -> Result<Value, String> {
    if request.kind != "native_request"
        || !crate::plugin_windows::valid_id(&request.plugin_id)
        || request.id.is_empty()
        || request.id.len() > 100
    {
        return Err("无效原生请求".into());
    }
    let required = match request.operation.as_str() {
        "registry.read" | "registry.write" => "registry-current-user",
        "wallpaper.get" | "wallpaper.set" => "wallpaper",
        "process.list" | "process.spawn" | "process.terminate" => "process-control",
        _ => return Err("未知原生能力".into()),
    };
    if request.permission != required {
        return Err("原生能力权限不匹配".into());
    }
    #[cfg(windows)]
    {
        match required {
            "registry-current-user" => registry::execute(&request.operation, &request.input),
            "wallpaper" => wallpaper::execute(&request.operation, &request.input),
            _ => process::execute(&request.operation, &request.input),
        }
    }
    #[cfg(not(windows))]
    Err("此原生能力仅支持 Windows".into())
}
pub(crate) fn handle(app: &AppHandle, value: &Value, pid: u32) -> bool {
    if value["type"] != "native_request" {
        return false;
    }
    let app = app.clone();
    let value = value.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = value["id"].as_str().unwrap_or("").to_owned();
        let result = if value.to_string().len() > 128 * 1024 {
            Err("原生请求过大".to_owned())
        } else {
            serde_json::from_value::<Request>(value)
                .map_err(|e| e.to_string())
                .and_then(|request| execute(&request))
        };
        let response = match result {
            Ok(result) => json!({"type":"native_response","id":id,"ok":true,"result":result}),
            Err(message) => json!({"type":"native_response","id":id,"ok":false,"message":message}),
        };
        if let Err(error) = crate::controller::send_native_response(&app, pid, response) {
            eprintln!("Native reply: {error}");
        }
    });
    true
}
