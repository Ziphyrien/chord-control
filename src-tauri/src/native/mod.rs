//! Capability transport only. Grants are checked by the controller; this boundary checks
//! the declared capability and input shape without knowing any plugin's policy.
#[cfg(windows)]
pub(crate) mod process;
#[cfg(windows)]
mod registry;
#[cfg(windows)]
mod wallpaper;
use crate::{controller::Generation, sync::lock};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Mutex};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(crate) struct NativeState {
    active: Mutex<HashSet<(Generation, String)>>,
}
struct Ticket {
    app: AppHandle,
    generation: Generation,
    id: String,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        lock(&self.app.state::<NativeState>().active).remove(&(self.generation, self.id.clone()));
    }
}
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
impl Request {
    fn execute(&self) -> Result<Value, String> {
        if self.kind != "native_request"
            || !crate::wire::valid_plugin_id(&self.plugin_id)
            || self.id.is_empty()
            || self.id.len() > 100
        {
            return Err("无效原生请求".into());
        }
        let permission = match self.operation.as_str() {
            "registry.read" | "registry.write" => "registry-current-user",
            "wallpaper.get" | "wallpaper.set" => "wallpaper",
            "process.list" | "process.spawn" | "process.terminate" => "process-control",
            _ => return Err("未知原生能力".into()),
        };
        if self.permission != permission {
            return Err("原生能力权限不匹配".into());
        }
        #[cfg(windows)]
        {
            match permission {
                "registry-current-user" => registry::execute(&self.operation, &self.input),
                "wallpaper" => wallpaper::execute(&self.operation, &self.input),
                _ => process::execute(&self.operation, &self.input),
            }
        }
        #[cfg(not(windows))]
        {
            Err("此原生能力仅支持 Windows".into())
        }
    }
}
fn reply(app: &AppHandle, generation: Generation, id: &str, result: Result<Value, String>) {
    let value = match result {
        Ok(result) => json!({"type":"native_response","id":id,"ok":true,"result":result}),
        Err(message) => json!({"type":"native_response","id":id,"ok":false,"message":message}),
    };
    if let Err(error) = crate::controller::send_generation(app, generation, value) {
        eprintln!("Native reply discarded: {error}");
    }
}
pub(crate) fn handle(app: &AppHandle, value: &Value, generation: Generation) -> bool {
    if value["type"] != "native_request" {
        return false;
    }
    if !crate::controller::is_current(app, generation) {
        return true;
    }
    let id = value["id"].as_str().unwrap_or("").to_owned();
    let request = if value.to_string().len() > 128 * 1024 {
        Err("原生请求过大".into())
    } else {
        serde_json::from_value::<Request>(value.clone()).map_err(|e| e.to_string())
    };
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            reply(app, generation, &id, Err(error));
            return true;
        }
    };
    {
        let state = app.state::<NativeState>();
        let mut active = lock(&state.active);
        if active.len() >= 8 || !active.insert((generation, id.clone())) {
            drop(active);
            reply(
                app,
                generation,
                &id,
                Err("原生请求重复或并发调用过多".into()),
            );
            return true;
        }
    }
    let ticket = Ticket {
        app: app.clone(),
        generation,
        id: id.clone(),
    };
    if request.operation.starts_with("host.") {
        let handle = app.clone();
        let response_id = id.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let _ticket = ticket;
            if !crate::controller::is_current(&handle, generation) {
                return;
            }
            let result = if request.kind != "native_request"
                || !crate::wire::valid_plugin_id(&request.plugin_id)
                || request.id.is_empty()
                || request.id.len() > 100
                || request.permission != "host-control"
            {
                Err("无效宿主能力请求".into())
            } else {
                crate::kernel::execute(
                    &handle,
                    generation,
                    &request.plugin_id,
                    &request.operation,
                    &request.input,
                )
            };
            reply(&handle, generation, &response_id, result);
        }) {
            lock(&app.state::<NativeState>().active).remove(&(generation, id.clone()));
            reply(app, generation, &id, Err(error.to_string()));
        }
        return true;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("native-capability".into())
        .spawn(move || {
            // Recheck on execution as well as submission; no queued work from a dead generation.
            if !crate::controller::is_current(&ticket.app, ticket.generation) {
                return;
            }
            let result = request.execute();
            reply(&ticket.app, ticket.generation, &ticket.id, result);
            // Individual Win32 APIs may not be interruptible. Never join these on shutdown;
            // the global ticket cap bounds them even across controller restarts.
        })
    {
        reply(app, generation, &id, Err(error.to_string()));
    }
    true
}
