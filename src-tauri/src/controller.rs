use crate::desktop::data_dir;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
pub(crate) struct ControllerState {
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
}
pub(crate) fn emit(app: &AppHandle, payload: serde_json::Value) {
    // Plugin iframes have no Tauri capabilities; only the control window gets events.
    let _ = app.emit_to("main", "controller:event", payload.to_string());
}
#[tauri::command]
pub(crate) fn controller_command(
    state: State<'_, ControllerState>,
    desktop: State<'_, crate::desktop::DesktopState>,
    command: String,
) -> Result<(), String> {
    if command.len() > 2 * 1024 * 1024 {
        return Err("Command exceeds size limit".into());
    }
    let value: serde_json::Value = serde_json::from_str(&command).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("Command must be an object".into());
    }
    let kind = value["type"].as_str().unwrap_or("");
    if matches!(kind, "shutdown" | "desktop_action" | "plugin_window_closed") {
        return Err("Reserved desktop command".into());
    }
    if kind != "snapshot" && !desktop.unlocked.load(Ordering::SeqCst) {
        return Err("控制中心尚未解锁".into());
    }
    let mut lock = state.child.lock().map_err(|_| "Controller lock poisoned")?;
    lock.as_mut()
        .ok_or("控制器离线，请从托盘重新启动控制器")?
        .write(format!("{}\n", value).as_bytes())
        .map_err(|e| e.to_string())
}
pub(crate) fn send_internal(app: &AppHandle, value: serde_json::Value) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let mut lock = state.child.lock().map_err(|_| "Controller lock poisoned")?;
    lock.as_mut()
        .ok_or("控制器离线")?
        .write(format!("{}\n", value).as_bytes())
        .map_err(|e| e.to_string())
}
pub(crate) fn start_controller(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let mut lock = state.child.lock().map_err(|_| "Controller lock poisoned")?;
    if lock.is_some() {
        return Ok(());
    }
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (mut events, child) = app
        .shell()
        .sidecar("plugin-controller")
        .map_err(|e| e.to_string())?
        .args(["--stdio"])
        .env("CHORD_CONTROL_DATA_DIR", &dir)
        .spawn()
        .map_err(|e| format!("无法启动控制器: {e}"))?;
    let pid = child.pid();
    lock.replace(child);
    drop(lock);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let log_path = dir.join("controller-stderr.log");
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    match serde_json::from_slice::<serde_json::Value>(&line) {
                        Ok(value) => {
                            crate::desktop::handle_event(&handle, &value);
                            emit(&handle, value);
                        }
                        Err(error) => emit(
                            &handle,
                            serde_json::json!({"type":"error", "message":format!("控制器协议错误: {error}")}),
                        ),
                    }
                }
                CommandEvent::Stderr(line) => {
                    if fs::metadata(&log_path)
                        .map(|m| m.len() > 1024 * 1024)
                        .unwrap_or(false)
                    {
                        let _ = fs::write(&log_path, b"");
                    }
                    if let Ok(mut file) =
                        OpenOptions::new().create(true).append(true).open(&log_path)
                    {
                        let _ = file.write_all(&line);
                        let _ = file.write_all(b"\n");
                    }
                }
                CommandEvent::Error(error) => emit(
                    &handle,
                    serde_json::json!({"type":"error", "message":error}),
                ),
                CommandEvent::Terminated(payload) => {
                    crate::desktop::disconnected(&handle);
                    emit(
                        &handle,
                        serde_json::json!({"type":"disconnected", "message":format!("控制器已退出 ({:?})，可从托盘重新启动", payload.code)}),
                    );
                }
                _ => {}
            }
        }
        let state = handle.state::<ControllerState>();
        if let Ok(mut lock) = state.child.lock() {
            if lock.as_ref().map(|c| c.pid()) == Some(pid) {
                lock.take();
            }
        };
    });
    Ok(())
}
pub(crate) fn quit(app: &AppHandle) {
    let state = app.state::<ControllerState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut lock) = state.child.lock() {
        if let Some(child) = lock.as_mut() {
            let _ = child.write(b"{\"id\":\"exit\",\"type\":\"shutdown\"}\n");
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        for _ in 0..50 {
            if handle
                .state::<ControllerState>()
                .child
                .lock()
                .map(|c| c.is_none())
                .unwrap_or(true)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        handle.exit(0);
    });
}
pub(crate) fn kill(app: &AppHandle) {
    if let Ok(mut lock) = app.state::<ControllerState>().child.lock() {
        if let Some(child) = lock.take() {
            let _ = child.kill();
        }
    }
}
