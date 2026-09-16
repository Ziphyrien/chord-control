use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;
#[derive(Default)]
pub(crate) struct UpdateState {
    busy: AtomicBool,
}
async fn check(app: &AppHandle, install: bool) -> Result<(), String> {
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(90))
        .restart_after_install(false)
        .installer_args(["/R"])
        .on_before_exit(move || crate::controller::prepare_update(&handle))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        if install {
            if let Some(tray) = app.tray_by_id("controller") {
                let _ = tray.set_tooltip(Some("Chord Control — 已是最新版本"));
            }
        }
        return Ok(());
    };
    if !install {
        if let Some(tray) = app.tray_by_id("controller") {
            let _ = tray.set_tooltip(Some(format!(
                "Chord Control — 主程序 {} 可更新，解锁后从托盘安装",
                update.version
            )));
        }
        return Ok(());
    }
    // download() checks the embedded public key before any process is stopped.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    if !app
        .state::<crate::desktop::DesktopState>()
        .unlocked
        .load(Ordering::SeqCst)
    {
        return Err("控制中心已锁定，请重新解锁后安装更新".into());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        update.install(bytes).map_err(|error| {
            // Restore service if extraction or installer launch fails.
            crate::controller::resume_after_update(&handle);
            error.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn run(app: &AppHandle, install: bool) {
    if app.state::<UpdateState>().busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = check(&app, install).await {
            crate::desktop::report(&app, &format!("主程序更新: {error}"));
        }
        app.state::<UpdateState>()
            .busy
            .store(false, Ordering::SeqCst);
    });
}
pub(crate) fn request(app: &AppHandle) {
    if !app
        .state::<crate::desktop::DesktopState>()
        .unlocked
        .load(Ordering::SeqCst)
    {
        crate::desktop::report(app, "请先打开并解锁控制中心，再安装主程序更新");
        crate::desktop::request_action(app, "open");
        return;
    }
    run(app, true);
}
pub(crate) fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            run(&app, false);
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}
