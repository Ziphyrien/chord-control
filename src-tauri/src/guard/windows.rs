use super::session::{Gate, Run};
use crate::sync::{lock, Cancellation, RestartBudget};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;

struct Session {
    run: Run,
    cancel: Cancellation,
    finished: mpsc::Receiver<()>,
}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
const TICK: Duration = Duration::from_millis(100);

struct Options {
    dir: PathBuf,
    watchdog: Option<String>,
    resume: Option<String>,
    maintenance: bool,
}
impl Options {
    fn read() -> Result<Self, String> {
        let args: Vec<OsString> = std::env::args_os().skip(1).collect();
        let mut dir = std::env::var_os("CHORD_CONTROL_GUARD_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("LOCALAPPDATA")
                    .map(|v| PathBuf::from(v).join("ChordControl/guard"))
            })
            .ok_or("LOCALAPPDATA unavailable")?;
        let mut watchdog = None;
        let mut resume = None;
        let mut maintenance = false;
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            if arg == "--maintenance-stop" {
                maintenance = true;
            } else if arg == "--guard-directory" {
                index += 1;
                dir = PathBuf::from(args.get(index).ok_or("Missing guard directory")?);
            } else if arg == "--watchdog" || arg == "--guard-resume" {
                index += 1;
                let token = args
                    .get(index)
                    .and_then(|v| v.to_str())
                    .ok_or("Missing guard token")?;
                if token.is_empty() || token.len() > 128 || token.starts_with("--") {
                    return Err("Invalid guard token".into());
                }
                let slot = if arg == "--watchdog" {
                    &mut watchdog
                } else {
                    &mut resume
                };
                if slot.replace(token.to_owned()).is_some() {
                    return Err("Duplicate guard mode".into());
                }
            }
            index += 1;
        }
        if usize::from(maintenance)
            + usize::from(watchdog.is_some())
            + usize::from(resume.is_some())
            > 1
        {
            return Err("Conflicting guard modes".into());
        }
        if !dir.is_absolute() {
            return Err("Guard directory must be absolute".into());
        }
        // Canonicalize existing directories so aliases address the same cross-process gate.
        if dir.exists() {
            dir = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            dir,
            watchdog,
            resume,
            maintenance,
        })
    }
}
fn wait(run: &Run, cancel: &Cancellation, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    loop {
        if cancel.is_cancelled() || !run.active() {
            return false;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return true;
        }
        if !cancel.wait(left.min(TICK)) {
            return false;
        }
    }
}
fn launch_peer(run: &Run, role: &str, cancel: &Cancellation) -> Result<(), String> {
    if !wait(run, cancel, Duration::ZERO) {
        return Ok(());
    }
    let mode = if role == "desktop" {
        "--guard-resume"
    } else {
        "--watchdog"
    };
    crate::shell_launch::launch(
        vec![
            "--background".into(),
            mode.into(),
            run.token.clone().into(),
            "--guard-directory".into(),
            run.dir.clone().into_os_string(),
        ],
        cancel,
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while wait(run, cancel, TICK) {
        if run.alive(role) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("{role} did not acknowledge Explorer launch"));
        }
    }
    Ok(())
}
fn watchdog(run: Run) -> Result<(), String> {
    let Ok(_single) = Gate::acquire(&run.dir, &format!("watchdog:{}", run.token), 0) else {
        return Ok(());
    };
    {
        let _gate = Gate::acquire(&run.dir, "session", 2000)?;
        if !run.active() {
            return Ok(());
        }
        run.record("watchdog")?;
    }
    let cancel = Cancellation::default();
    let mut budget = RestartBudget::default();
    while wait(&run, &cancel, TICK) {
        if run.alive("desktop") {
            budget.healthy();
            continue;
        }
        let Some(delay) = budget.next() else {
            run.log("Desktop restart budget exhausted; manual start required");
            let _gate = Gate::acquire(&run.dir, "session", 2000)?;
            run.revoke()?;
            break;
        };
        if !wait(&run, &cancel, delay) {
            break;
        }
        if !run.alive("desktop") {
            if let Err(error) = launch_peer(&run, "desktop", &cancel) {
                run.log(&error);
            }
        }
    }
    Ok(())
}
pub(super) fn handle_cli() -> Result<bool, String> {
    let options = Options::read()?;
    if options.maintenance {
        // Hold the gate through the drain. Late resumers cannot publish after this wait
        // or generate a replacement token; new manual starts time out at the same gate.
        let _gate = Gate::acquire(&options.dir, "session", 2000)?;
        let run = Run::current(options.dir);
        run.revoke()?;
        let deadline = Instant::now() + Duration::from_secs(45);
        while run.alive("desktop") || run.alive("watchdog") {
            if Instant::now() >= deadline {
                return Err("Maintenance stop timed out".into());
            }
            std::thread::sleep(TICK);
        }
        return Ok(true);
    }
    if let Some(token) = options.watchdog {
        watchdog(Run {
            dir: options.dir,
            token,
        })?;
        return Ok(true);
    }
    if let Some(token) = options.resume {
        // This check is repeated under the gate in start(), after Tauri initialization.
        return Ok(!Run {
            dir: options.dir,
            token,
        }
        .active());
    }
    Ok(false)
}
pub(super) fn start(app: &AppHandle, fresh: bool) -> Result<(), String> {
    let options = Options::read()?;
    if cfg!(debug_assertions)
        && options.resume.is_none()
        && std::env::var("CHORD_CONTROL_TEST_GUARD").as_deref() != Ok("1")
    {
        return Ok(());
    }
    let mut session = lock(&SESSION);
    if session
        .as_ref()
        .is_some_and(|value| !value.cancel.is_cancelled())
    {
        return Ok(());
    }
    // A failed stop retains its session so a later explicit recovery can retry revocation.
    if let Some(previous) = session.as_ref() {
        if previous.run.active() {
            let _gate = Gate::acquire(&previous.run.dir, "session", 2000)?;
            previous.run.revoke()?;
        }
    }
    *session = None;
    std::fs::create_dir_all(&options.dir).map_err(|e| e.to_string())?;
    let dir = std::fs::canonicalize(options.dir).map_err(|e| e.to_string())?;
    let _gate = Gate::acquire(&dir, "session", 2000)?;
    let run = Run::begin(
        dir,
        if fresh {
            None
        } else {
            options.resume.as_deref()
        },
    )?;
    let cancel = Cancellation::default();
    let worker_cancel = cancel.clone();
    let worker_run = run.clone();
    let handle = app.clone();
    let (send, finished) = mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new()
        .name("guard-monitor".into())
        .spawn(move || {
            let run = worker_run;
            let mut budget = RestartBudget::default();
            let mut exhausted = false;
            while wait(&run, &worker_cancel, TICK) {
                if exhausted {
                    continue;
                }
                if run.alive("watchdog") {
                    budget.healthy();
                    continue;
                }
                let Some(delay) = budget.next() else {
                    exhausted = true;
                    run.log("Watchdog restart budget exhausted");
                    crate::desktop::report(&handle, "自动恢复功能异常，请重新启动 Chord Control");
                    continue;
                };
                if !wait(&run, &worker_cancel, delay) {
                    break;
                }
                if !run.alive("watchdog") {
                    if let Err(error) = launch_peer(&run, "watchdog", &worker_cancel) {
                        run.log(&error);
                    }
                }
            }
            let revoked = !worker_cancel.is_cancelled();
            let _ = send.send(());
            if revoked {
                crate::lifecycle::quit(&handle);
            }
        })
    {
        run.revoke()?;
        return Err(error.to_string());
    }
    *session = Some(Session {
        run,
        cancel,
        finished,
    });
    Ok(())
}
pub(super) fn stop() -> Result<(), String> {
    // Never hold SESSION while waiting for workers or an external process gate.
    let Some(session) = lock(&SESSION).take() else {
        return Ok(());
    };
    session.cancel.cancel();
    // If maintenance already removed the token, it may hold the gate while waiting for us.
    let result = if session.run.active() {
        Gate::acquire(&session.run.dir, "session", 2000).and_then(|_gate| session.run.revoke())
    } else {
        Ok(())
    };
    let _ = session.finished.recv_timeout(Duration::from_secs(1));
    if let Err(error) = result {
        *lock(&SESSION) = Some(session);
        return Err(error);
    }
    let deadline = Instant::now() + Duration::from_secs(6);
    while session.run.alive("watchdog") {
        if Instant::now() >= deadline {
            return Err("Watchdog did not stop after revocation".into());
        }
        std::thread::sleep(TICK);
    }
    Ok(())
}
