//! Controller generations own a transport, event routing and a bounded restart policy.
mod transport;
use crate::sync::{lock, Cancellation, RestartBudget};
use serde_json::{json, Value};
use std::{
    sync::{
        mpsc::{self, SyncSender},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use transport::{Event, Transport, MAX_FRAME};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Generation(u64);
struct Connection {
    generation: Generation,
    input: SyncSender<Vec<u8>>,
    stop: Cancellation,
    force: Cancellation,
}
#[derive(Default)]
struct Inner {
    sequence: u64,
    connection: Option<Connection>,
    stopping: bool,
    blocked: bool,
    retries: RestartBudget,
    retry_cancel: Cancellation,
}
#[derive(Default)]
pub(crate) struct ControllerState {
    inner: Mutex<Inner>,
}

pub(crate) fn emit(app: &AppHandle, value: Value) {
    let _ = app.emit_to("main", "controller:event", value.to_string());
}
pub(crate) fn is_current(app: &AppHandle, generation: Generation) -> bool {
    lock(&app.state::<ControllerState>().inner)
        .connection
        .as_ref()
        .is_some_and(|connection| {
            connection.generation == generation && !connection.force.is_cancelled()
        })
}
fn enqueue(connection: &Connection, value: &Value) -> Result<(), String> {
    if connection.force.is_cancelled() {
        return Err("控制器正在释放资源".into());
    }
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() >= MAX_FRAME {
        return Err("Command exceeds size limit".into());
    }
    bytes.push(b'\n');
    connection
        .input
        .try_send(bytes)
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => "控制器请求队列已满，请稍后重试".into(),
            mpsc::TrySendError::Disconnected(_) => "控制器离线".into(),
        })
}
#[tauri::command]
pub(crate) fn controller_command(
    app: AppHandle,
    window: tauri::WebviewWindow,
    desktop: State<'_, crate::desktop::DesktopState>,
    command: String,
) -> Result<(), String> {
    crate::desktop::require_main(&window)?;
    if command.len() >= MAX_FRAME {
        return Err("Command exceeds size limit".into());
    }
    let value: Value = serde_json::from_str(&command).map_err(|e| e.to_string())?;
    crate::wire::validate_public_command(&value)?;
    if value["type"] != "snapshot" && !desktop.is_unlocked() {
        return Err("控制中心尚未解锁".into());
    }
    // Forward the original object. Generic affectedPluginIds and future payload data
    // are interpreted by the controller, never by desktop/plugin-specific policy.
    send_internal(&app, value)
}
pub(crate) fn send_internal(app: &AppHandle, value: Value) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let inner = lock(&state.inner);
    if inner.stopping {
        return Err("控制器正在退出".into());
    }
    enqueue(
        inner
            .connection
            .as_ref()
            .ok_or("控制器离线，请从托盘重新启动")?,
        &value,
    )
}
pub(crate) fn send_generation(
    app: &AppHandle,
    generation: Generation,
    value: Value,
) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let inner = lock(&state.inner);
    // Graceful plugin disposal still needs native replies after shutdown begins.
    let connection = inner
        .connection
        .as_ref()
        .filter(|c| c.generation == generation && !c.force.is_cancelled())
        .ok_or("原生请求所属的控制器已退出")?;
    enqueue(connection, &value)
}
fn schedule_retry(app: &AppHandle, sequence: u64) {
    let state = app.state::<ControllerState>();
    let mut inner = lock(&state.inner);
    if inner.stopping || inner.blocked || inner.sequence != sequence || inner.connection.is_some() {
        return;
    }
    let Some(delay) = inner.retries.next() else {
        drop(inner);
        crate::desktop::report(
            app,
            "控制器连续失败，已停止自动重启，请查看日志或从托盘重试",
        );
        return;
    };
    let cancel = inner.retry_cancel.clone();
    drop(inner);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if cancel.is_cancelled() {
            return;
        }
        let valid = {
            let state = app.state::<ControllerState>();
            let inner = lock(&state.inner);
            inner.sequence == sequence && !inner.stopping && inner.connection.is_none()
        };
        if valid {
            if let Err(error) = start_controller(&app) {
                crate::desktop::report(&app, &error);
            }
        }
    });
}
pub(crate) fn start_controller(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ControllerState>();
    let mut inner = lock(&state.inner);
    if inner.stopping || !crate::lifecycle::is_running(app) {
        return Err("控制器正在退出".into());
    }
    if inner.blocked {
        return Err("控制器资源未释放，请重新启动主程序".into());
    }
    if inner.connection.is_some() {
        return Ok(());
    }
    inner.sequence = inner
        .sequence
        .checked_add(1)
        .ok_or("Controller generation exhausted")?;
    let generation = Generation(inner.sequence);
    let result = crate::desktop::data_dir(app).and_then(|dir| {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Transport::spawn(&dir)
    });
    let mut transport = match result {
        Ok(transport) => transport,
        Err(error) => {
            drop(inner);
            schedule_retry(app, generation.0);
            return Err(error);
        }
    };
    let stop = Cancellation::default();
    let force = Cancellation::default();
    inner.connection = Some(Connection {
        generation,
        input: transport.input.clone(),
        stop: stop.clone(),
        force: force.clone(),
    });
    let handle = app.clone();
    let spawn = std::thread::Builder::new().name("controller-supervisor".into()).spawn(move || {
        let started = Instant::now();
        let mut shutdown_at = None;
        let mut fault = None;
        loop {
            if force.is_cancelled() { break; }
            if stop.is_cancelled() && shutdown_at.is_none() {
                shutdown_at = Some(Instant::now());
                // A full/non-reading input pipe must never block the shutdown deadline.
                let _ = transport.input.try_send(b"{\"id\":\"exit\",\"type\":\"shutdown\"}\n".to_vec());
            }
            if shutdown_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(22)) { break; }
            match transport.events.recv_timeout(Duration::from_millis(50)) {
                Ok(Event::Frame(line)) if is_current(&handle, generation) => {
                    match serde_json::from_slice::<Value>(&line) {
                        Ok(value) if value.is_object() => {
                            if !crate::native::handle(&handle, &value, generation) {
                                crate::desktop::handle_event(&handle, &value, generation);
                                emit(&handle, value);
                            }
                        }
                        _ => { fault = Some("控制器协议错误".to_owned()); break; }
                    }
                }
                Ok(Event::Fault(error)) => { fault = Some(error); break; }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                _ => {},
            }
            match transport.exited() {
                Ok(true) => break,
                Ok(false) => {},
                Err(error) => { fault = Some(error); break; }
            }
        }
        // Invalidate before draining I/O: delayed native/UI responses cannot cross generations.
        {
            let state = handle.state::<ControllerState>();
            let mut inner = lock(&state.inner);
            if inner.connection.as_ref().is_some_and(|c| c.generation == generation) {
                // Leave the connection as a tombstone until all workers have drained.
                inner.connection.as_mut().unwrap().force.cancel();
            }
        }
        crate::desktop::disconnected(&handle);
        let drained = transport.stop();
        let state = handle.state::<ControllerState>();
        let mut inner = lock(&state.inner);
        if inner.connection.as_ref().is_some_and(|c| c.generation == generation) { inner.connection = None; }
        if !drained { inner.blocked = true; }
        if started.elapsed() >= Duration::from_secs(60) { inner.retries = RestartBudget::default(); }
        let stopping = inner.stopping;
        drop(inner);
        if !stopping {
            emit(&handle, json!({"type":"disconnected","message":fault.unwrap_or_else(|| "控制器已退出，正在尝试恢复".into())}));
            schedule_retry(&handle, generation.0);
        }
    });
    if let Err(error) = spawn {
        inner.connection = None;
        drop(inner);
        schedule_retry(app, generation.0);
        return Err(error.to_string());
    }
    Ok(())
}
/// Returns after a bounded grace period; does not join pipe or native workers.
pub(crate) fn shutdown(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<ControllerState>();
        let mut inner = lock(&state.inner);
        inner.stopping = true;
        inner.retry_cancel.cancel();
        if let Some(connection) = &inner.connection {
            connection.stop.cancel();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(24);
    loop {
        let state = app.state::<ControllerState>();
        let inner = lock(&state.inner);
        if inner.connection.is_none() {
            return if inner.blocked {
                Err("控制器资源无法完整释放".into())
            } else {
                Ok(())
            };
        }
        if Instant::now() >= deadline {
            if let Some(connection) = &inner.connection {
                connection.force.cancel();
            }
            return Err("控制器关闭超时".into());
        }
        drop(inner);
        std::thread::sleep(Duration::from_millis(50));
    }
}
pub(crate) fn resume(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<ControllerState>();
        let mut inner = lock(&state.inner);
        if inner.connection.is_some() || inner.blocked {
            return Err("旧控制器仍未释放，请重新启动主程序".into());
        }
        inner.stopping = false;
        inner.retry_cancel = Cancellation::default();
        inner.retries = RestartBudget::default();
    }
    start_controller(app)
}
pub(crate) fn force_stop(app: &AppHandle) {
    let state = app.state::<ControllerState>();
    let mut inner = lock(&state.inner);
    inner.stopping = true;
    inner.retry_cancel.cancel();
    if let Some(connection) = &inner.connection {
        connection.force.cancel();
    }
}
