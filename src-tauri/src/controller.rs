use crate::desktop::data_dir;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
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
    failures: AtomicU32,
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
    if matches!(
        kind,
        "shutdown" | "desktop_action" | "plugin_window_closed" | "native_response"
    ) {
        return Err("Reserved desktop command".into());
    }
    if kind != "snapshot" && !desktop.unlocked.load(Ordering::SeqCst) {
        return Err("控制中心尚未解锁".into());
    }
    let mut lock = crate::sync::lock(&state.child);
    lock.as_mut()
        .ok_or("控制器离线，请从托盘重新启动控制器")?
        .write(format!("{}\n", value).as_bytes())
        .map_err(|e| e.to_string())
}
pub(crate) fn send_internal(app: &AppHandle, value: serde_json::Value) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let mut lock = crate::sync::lock(&state.child);
    lock.as_mut()
        .ok_or("控制器离线")?
        .write(format!("{}\n", value).as_bytes())
        .map_err(|e| e.to_string())
}
pub(crate) fn send_native_response(
    app: &AppHandle,
    pid: u32,
    value: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let mut lock = crate::sync::lock(&state.child);
    let child = lock
        .as_mut()
        .filter(|child| child.pid() == pid)
        .ok_or("原生请求所属的控制器已退出")?;
    child
        .write(format!("{value}\n").as_bytes())
        .map_err(|e| e.to_string())
}
pub(crate) fn start_controller(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let mut lock = crate::sync::lock(&state.child);
    if state.quitting.load(Ordering::SeqCst) {
        return Err("控制器正在退出".into());
    }
    if lock.is_some() {
        return Ok(());
    }
    let dir = data_dir(app)?;
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
    let started = std::time::Instant::now();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let log_path = dir.join("controller-stderr.log");
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    match serde_json::from_slice::<serde_json::Value>(&line) {
                        Ok(value) => {
                            if !crate::native::handle(&handle, &value, pid) {
                                crate::desktop::handle_event(&handle, &value);
                                emit(&handle, value);
                            }
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
        {
            let mut lock = crate::sync::lock(&state.child);
            if lock.as_ref().map(|c| c.pid()) == Some(pid) {
                lock.take();
            }
        }
        if !state.quitting.load(Ordering::SeqCst) {
            let stable = started.elapsed() >= Duration::from_secs(60);
            let retry = if stable {
                state.failures.store(0, Ordering::SeqCst);
                0
            } else {
                state.failures.fetch_add(1, Ordering::SeqCst)
            };
            if retry < 5 {
                let retry_handle = handle.clone();
                let delay = Duration::from_secs(1_u64 << retry.min(4));
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    if !retry_handle
                        .state::<ControllerState>()
                        .quitting
                        .load(Ordering::SeqCst)
                    {
                        if let Err(error) = start_controller(&retry_handle) {
                            crate::desktop::report(&retry_handle, &error);
                        }
                    }
                });
            } else {
                crate::desktop::report(&handle, "控制器连续失败，已停止自动重启，请查看日志");
            }
        }
    });
    Ok(())
}
fn stop_controller(app: &AppHandle) {
    if let Some(child) = crate::sync::lock(&app.state::<ControllerState>().child).as_mut() {
        let _ = child.write(b"{\"id\":\"exit\",\"type\":\"shutdown\"}\n");
    }
    for _ in 0..200 {
        if crate::sync::lock(&app.state::<ControllerState>().child).is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    kill(app);
}
pub(crate) fn quit(app: &AppHandle) {
    if app
        .state::<ControllerState>()
        .quitting
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        crate::guard::stop();
        stop_controller(&app);
        app.exit(0);
    });
}
pub(crate) fn prepare_update(app: &AppHandle) {
    app.state::<ControllerState>()
        .quitting
        .store(true, Ordering::SeqCst);
    crate::guard::stop();
    stop_controller(app);
}
pub(crate) fn resume_after_update(app: &AppHandle) {
    app.state::<ControllerState>()
        .quitting
        .store(false, Ordering::SeqCst);
    if let Err(error) = crate::guard::start(app).and_then(|()| start_controller(app)) {
        crate::desktop::report(app, &error);
    }
}
pub(crate) fn kill(app: &AppHandle) {
    if let Some(child) = crate::sync::lock(&app.state::<ControllerState>().child).take() {
        let _ = child.kill();
    }
}
