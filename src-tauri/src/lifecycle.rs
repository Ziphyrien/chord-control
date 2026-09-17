//! One owner for exit/update ordering: lock UI, revoke peers, drain plugins, then exit/install.
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tauri::{AppHandle, Manager};
const RUNNING: u8 = 0;
const UPDATING: u8 = 1;
const QUITTING: u8 = 2;
const STOPPED: u8 = 3;
#[derive(Default)]
pub(crate) struct Lifecycle {
    phase: AtomicU8,
    quit_requested: AtomicBool,
}
pub(crate) fn is_running(app: &AppHandle) -> bool {
    app.state::<Lifecycle>().phase.load(Ordering::Acquire) == RUNNING
}
fn drain(app: &AppHandle) -> Result<(), String> {
    crate::desktop::disconnected(app);
    // Drain the controller even when revocation fails, while preserving the first error.
    let guard = crate::guard::stop();
    let controller = crate::controller::shutdown(app);
    guard.and(controller)
}
pub(crate) fn quit(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    match state
        .phase
        .compare_exchange(RUNNING, QUITTING, Ordering::AcqRel, Ordering::Acquire)
    {
        Ok(_) => {}
        Err(UPDATING) => {
            state.quit_requested.store(true, Ordering::Release);
            return;
        }
        Err(_) => return,
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = drain(&handle) {
            crate::desktop::report(&handle, &error);
            // Do not report a successful quit while a session could still resurrect us.
            handle
                .state::<Lifecycle>()
                .phase
                .store(RUNNING, Ordering::Release);
            if let Err(recovery) = crate::guard::restart_after_update(&handle)
                .and_then(|()| crate::controller::resume(&handle))
            {
                crate::desktop::report(&handle, &recovery);
            }
            return;
        }
        handle
            .state::<Lifecycle>()
            .phase
            .store(STOPPED, Ordering::Release);
        handle.exit(0);
    });
}
pub(crate) fn prepare_update(app: &AppHandle) -> Result<(), String> {
    app.state::<Lifecycle>()
        .phase
        .compare_exchange(RUNNING, UPDATING, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "程序正在退出或更新".to_owned())?;
    drain(app)
}
pub(crate) fn update_failed(app: &AppHandle) {
    let state = app.state::<Lifecycle>();
    if state
        .phase
        .compare_exchange(UPDATING, RUNNING, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    if state.quit_requested.swap(false, Ordering::AcqRel) {
        quit(app);
        return;
    }
    // Recovery is explicit and does not replay a revoked --guard-resume command line.
    if let Err(error) =
        crate::guard::restart_after_update(app).and_then(|()| crate::controller::resume(app))
    {
        crate::desktop::report(app, &error);
    }
}
pub(crate) fn update_launched(app: &AppHandle) {
    app.state::<Lifecycle>()
        .phase
        .store(STOPPED, Ordering::Release);
    app.exit(0);
}
pub(crate) fn exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi) {
    if app.state::<Lifecycle>().phase.load(Ordering::Acquire) != STOPPED {
        api.prevent_exit();
        quit(app);
    }
}
pub(crate) fn final_cleanup(app: &AppHandle) {
    // Normal exit already drained. Unexpected event-loop teardown still cancels owners.
    if let Err(error) = crate::guard::stop() {
        eprintln!("Guard teardown: {error}");
    }
    crate::controller::force_stop(app);
    if let Err(error) = crate::controller::shutdown(app) {
        eprintln!("Controller teardown: {error}");
    }
}
