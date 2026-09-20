//! Signed host updates. Downloads finish before peers or plugins are stopped.
pub(crate) mod diagnostics;
mod network;
mod policy;
use crate::sync::lock;
use policy::Policy;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
#[derive(Default)]
pub(crate) struct UpdateState {
    busy: AtomicBool,
    staging_failed: AtomicBool,
    progress: Mutex<Progress>,
    policy: Mutex<Option<Policy>>,
    wake: tokio::sync::Notify,
}
#[derive(Default)]
struct Progress {
    version: Option<String>,
    error: Option<String>,
    failures: u32,
}
pub(crate) fn configure(app: &AppHandle, settings: &Value) {
    let (Some(interval), Some(auto_install)) = (
        settings["appCheckIntervalMinutes"].as_u64(),
        settings["appAutoUpdate"].as_bool(),
    ) else {
        return;
    };
    let Some(policy) = Policy::new(interval, auto_install) else {
        return;
    };
    let state = app.state::<UpdateState>();
    let mut current = lock(&state.policy);
    if *current != Some(policy) {
        *current = Some(policy);
        state.wake.notify_one();
    }
}
fn automatic_install_enabled(app: &AppHandle) -> bool {
    lock(&app.state::<UpdateState>().policy).is_some_and(|policy| policy.auto_install)
}
pub(crate) fn status(app: &AppHandle) -> Value {
    let state = app.state::<UpdateState>();
    let progress = lock(&state.progress);
    json!({"busy":state.busy.load(Ordering::Acquire),
        "availableVersion":progress.version,"error":progress.error})
}
/// The host-control grant authorizes unattended signed updates. Return before plugin disposal.
pub(crate) fn request_plugin(app: &AppHandle, install: bool) -> Result<Value, String> {
    let started = run(app, install, false)?;
    Ok(json!({"started":started}))
}

#[cfg(windows)]
fn stage(app: &AppHandle, bytes: &[u8]) -> Result<PathBuf, String> {
    // Our release contract is Tauri's signed NSIS .exe artifact. Reject archives or
    // unexpected payloads rather than invoking a shell/file association to interpret them.
    let offset = bytes
        .get(0x3c..0x40)
        .and_then(|value| <[u8; 4]>::try_from(value).ok())
        .map(u32::from_le_bytes)
        .map(|value| value as usize)
        .ok_or("Invalid installer header")?;
    if !bytes.starts_with(b"MZ")
        || bytes.get(offset..offset.saturating_add(4)) != Some(b"PE\0\0".as_slice())
    {
        return Err("更新安装包格式无效，请重新检查更新".into());
    }
    let id = unsafe { windows::Win32::System::Com::CoCreateGuid() }.map_err(|e| e.to_string())?;
    let directory = crate::desktop::data_dir(app)?
        .join("updates")
        .join(format!("{id:?}"));
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("install.exe");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(path)
}
#[cfg(not(windows))]
fn stage(_app: &AppHandle, _bytes: &[u8]) -> Result<PathBuf, String> {
    Err("主程序更新仅支持 Windows".into())
}

fn launch_installer(path: &std::path::Path) -> Result<u32, String> {
    // Command uses CreateProcessW on Windows: current user's token, no COM, no runas,
    // no arbitrary wait on an Explorer ShellExecute call. The installer starts a fresh
    // hidden session after replacement; original process arguments are never replayed.
    let mut command = std::process::Command::new(path);
    command
        .args(["/S", "/UPDATE"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map(|child| child.id())
        .map_err(|e| e.to_string())
}
async fn check(
    app: &AppHandle,
    install: bool,
    require_unlock: bool,
    automatic: bool,
    trace: &diagnostics::Attempt,
) -> Result<(), String> {
    let update = network::check(app).await?;
    let Some(update) = update else {
        lock(&app.state::<UpdateState>().progress).version = None;
        if install {
            if let Some(tray) = app.tray_by_id("controller") {
                let _ = tray.set_tooltip(Some("Chord Control — 已是最新版本"));
            }
        }
        return Ok(());
    };
    trace.event(
        "update_available",
        json!({"target_version": update.version}),
    );
    lock(&app.state::<UpdateState>().progress).version = Some(update.version.clone());
    if !install || (automatic && !automatic_install_enabled(app)) {
        if let Some(tray) = app.tray_by_id("controller") {
            let _ = tray.set_tooltip(Some(format!(
                "Chord Control — 主程序 {} 可更新，解锁后从托盘安装",
                update.version
            )));
        }
        return Ok(());
    }
    trace.event(
        "download_started",
        json!({"target_version": update.version}),
    );
    let bytes = tokio::time::timeout(Duration::from_secs(180), network::download(&update))
        .await
        .map_err(|_| "下载更新超时".to_owned())??;
    trace.event("download_verified", json!({"bytes": bytes.len()}));
    if automatic && !automatic_install_enabled(app) {
        return Ok(());
    }
    if !crate::lifecycle::is_running(app)
        || (require_unlock && !app.state::<crate::desktop::DesktopState>().is_unlocked())
    {
        return Err("控制中心已锁定，请重新解锁后安装更新".into());
    }
    trace.event("staging_started", json!({}));
    let handle = app.clone();
    let staging = tauri::async_runtime::spawn_blocking(move || stage(&handle, &bytes));
    let path = match tokio::time::timeout(Duration::from_secs(30), staging).await {
        Ok(result) => result.map_err(|e| e.to_string())??,
        Err(_) => {
            // At most one detached filesystem task; it only writes bytes, never launches.
            app.state::<UpdateState>()
                .staging_failed
                .store(true, Ordering::Release);
            return Err("写入更新超时，请重新启动主程序后重试".into());
        }
    };
    trace.event("installer_staged", json!({"path": path}));
    if automatic && !automatic_install_enabled(app) {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    if !crate::lifecycle::is_running(app)
        || (require_unlock && !app.state::<crate::desktop::DesktopState>().is_unlocked())
    {
        let _ = fs::remove_file(&path);
        return Err("控制中心已锁定，更新已取消".into());
    }
    let handle = app.clone();
    let trace = trace.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if automatic && !automatic_install_enabled(&handle) {
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        trace.event("prepare_started", json!({}));
        let result = crate::lifecycle::prepare_update(&handle).and_then(|()| {
            trace.event("prepare_finished", json!({}));
            trace.event("installer_spawn_requested", json!({"path": path}));
            launch_installer(&path)
        });
        match result {
            Ok(pid) => {
                trace.event(
                    "installer_spawned",
                    json!({"installer_pid": pid, "path": path}),
                );
                trace.event("host_exit_requested", json!({}));
                crate::lifecycle::update_launched(&handle);
            }
            Err(error) => {
                trace.event("handoff_failed", json!({"error": error}));
                let _ = fs::remove_file(path);
                crate::lifecycle::update_failed(&handle);
                trace.event("host_recovery_requested", json!({}));
                return Err(error);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn begin(app: &AppHandle) -> Result<bool, String> {
    let state = app.state::<UpdateState>();
    if !crate::lifecycle::is_running(app) || state.staging_failed.load(Ordering::Acquire) {
        return Err("更新不可用，请重新启动主程序后重试".into());
    }
    if state.busy.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    lock(&state.progress).error = None;
    Ok(true)
}
async fn finish(app: &AppHandle, install: bool, require_unlock: bool, automatic: bool) {
    let trace = diagnostics::Attempt::new(install, automatic);
    let result = check(app, install, require_unlock, automatic, &trace).await;
    trace.event(
        "check_finished",
        json!({"ok": result.is_ok(), "error": result.as_ref().err()}),
    );
    let state = app.state::<UpdateState>();
    {
        let mut progress = lock(&state.progress);
        if let Err(error) = &result {
            progress.error = Some(error.clone());
            progress.failures = progress.failures.saturating_add(1);
        } else {
            progress.failures = 0;
        }
    }
    if let Err(error) = result {
        crate::desktop::report(app, &format!("主程序更新: {error}"));
    }
    state.busy.store(false, Ordering::Release);
    if !automatic {
        state.wake.notify_one();
    }
}
fn run(app: &AppHandle, install: bool, require_unlock: bool) -> Result<bool, String> {
    if !begin(app)? {
        return Ok(false);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        finish(&handle, install, require_unlock, false).await;
    });
    Ok(true)
}
pub(crate) fn request(app: &AppHandle) {
    if !app.state::<crate::desktop::DesktopState>().is_unlocked() {
        crate::desktop::report(app, "请先打开并解锁控制中心，再安装主程序更新");
        crate::desktop::request_action(app, crate::desktop::Action::Open);
        return;
    }
    if let Err(error) = run(app, true, true) {
        crate::desktop::report(app, &error);
    }
}
pub(crate) fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let state = handle.state::<UpdateState>();
        let mut first_check = true;
        while crate::lifecycle::is_running(&handle) {
            let policy = *lock(&state.policy);
            if let Some(policy) = policy {
                if !first_check {
                    let failures = lock(&state.progress).failures;
                    if tokio::time::timeout(policy.delay(failures), state.wake.notified())
                        .await
                        .is_ok()
                    {
                        // Settings and manual checks reset the delay, never trigger a check.
                        continue;
                    }
                }
                first_check = false;
                if begin(&handle).unwrap_or(false) {
                    finish(&handle, policy.auto_install, false, true).await;
                }
            } else {
                let _ = tokio::time::timeout(Duration::from_secs(30), state.wake.notified()).await;
            }
        }
    });
}
