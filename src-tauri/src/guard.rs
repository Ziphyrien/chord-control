//! The desktop and its watchdog share a revocable session. Maintenance and exit stop both.
#[cfg(windows)]
mod windows {
    use crate::native::process::{identity, open, Handle};
    use serde::{Deserialize, Serialize};
    use std::{
        fs,
        os::windows::process::CommandExt,
        path::PathBuf,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        thread::JoinHandle,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use tauri::AppHandle;
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_ALREADY_EXISTS, WAIT_TIMEOUT},
        System::Threading::{
            CreateMutexW, WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };

    #[derive(Clone)]
    struct Run {
        dir: PathBuf,
        token: String,
    }
    struct Session {
        run: Run,
        cancelled: Arc<AtomicBool>,
        monitor: JoinHandle<()>,
    }
    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    #[derive(Serialize, Deserialize)]
    struct Identity {
        pid: u32,
        executable: String,
        created: String,
        token: String,
    }

    fn dir() -> Result<PathBuf, String> {
        if let Some(root) = std::env::var_os("CHORD_CONTROL_GUARD_DIR") {
            return Ok(PathBuf::from(root));
        }
        std::env::var_os("LOCALAPPDATA")
            .map(|root| PathBuf::from(root).join("ChordControl/guard"))
            .ok_or("LOCALAPPDATA unavailable".into())
    }
    fn active(run: &Run) -> bool {
        fs::read_to_string(run.dir.join("run")).is_ok_and(|text| text == run.token)
    }
    fn revoke(run: &Run) {
        if active(run) {
            let _ = fs::remove_file(run.dir.join("run"));
        }
    }
    fn record(run: &Run, kind: &str) -> Result<(), String> {
        let pid = std::process::id();
        let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let (executable, created) = identity(&handle)?;
        let text = serde_json::to_vec(&Identity {
            pid,
            executable,
            created,
            token: run.token.clone(),
        })
        .map_err(|e| e.to_string())?;
        fs::write(run.dir.join(format!("{kind}.json")), text).map_err(|e| e.to_string())
    }
    fn alive(run: &Run, kind: &str) -> bool {
        let Ok(text) = fs::read(run.dir.join(format!("{kind}.json"))) else {
            return false;
        };
        let Ok(saved) = serde_json::from_slice::<Identity>(&text) else {
            return false;
        };
        if !run.token.is_empty() && saved.token != run.token {
            return false;
        }
        let Ok(handle) = open(
            saved.pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
        ) else {
            return false;
        };
        let Ok((exe, created)) = identity(&handle) else {
            return false;
        };
        let Ok(own) = std::env::current_exe() else {
            return false;
        };
        exe.eq_ignore_ascii_case(&saved.executable)
            && exe.eq_ignore_ascii_case(&own.to_string_lossy())
            && created == saved.created
            && unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_TIMEOUT
    }
    #[derive(Default)]
    struct Budget(Vec<Instant>);
    impl Budget {
        fn next(&mut self) -> Option<Duration> {
            let now = Instant::now();
            self.0
                .retain(|at| now.duration_since(*at) < Duration::from_secs(60));
            if self.0.len() >= 5 {
                return None;
            }
            let delay = Duration::from_secs(1_u64 << self.0.len());
            self.0.push(now);
            Some(delay)
        }
    }
    fn log(run: &Run, text: &str) {
        use std::io::Write;
        let path = run.dir.join("guard.log");
        if fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
            let _ = fs::write(&path, b"");
        }
        if let Ok(mut file) = fs::OpenOptions::new().append(true).create(true).open(path) {
            let _ = writeln!(file, "{text}");
        }
    }
    fn wait_active(run: &Run, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            if !active(run) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        active(run)
    }
    fn command() -> Result<Command, String> {
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        Ok(command)
    }
    fn watchdog(run: Run) -> Result<(), String> {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        run.dir.to_string_lossy().to_lowercase().hash(&mut hash);
        run.token.hash(&mut hash);
        let name: Vec<u16> = format!("Local\\ChordControlWatchdog-{:x}", hash.finish())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if mutex.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let _mutex = Handle(mutex);
        if exists || !active(&run) {
            return Ok(());
        }
        record(&run, "watchdog")?;
        let mut budget = Budget::default();
        while active(&run) {
            if alive(&run, "desktop") {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            let Some(delay) = budget.next() else {
                log(&run, "Desktop restart limit reached; manual start required");
                revoke(&run);
                break;
            };
            if !wait_active(&run, delay) {
                break;
            }
            if alive(&run, "desktop") {
                continue;
            }
            match command().and_then(|mut cmd| {
                cmd.args(["--background", "--guard-resume", &run.token])
                    .spawn()
                    .map_err(|e| e.to_string())
            }) {
                Ok(mut child) => {
                    log(&run, "Restarted desktop after process exit");
                    while active(&run) && child.try_wait().map_err(|e| e.to_string())?.is_none() {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
                Err(error) => log(&run, &error),
            }
        }
        Ok(())
    }
    pub(super) fn handle_cli() -> bool {
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|arg| arg == "--maintenance-stop") {
            let Ok(dir) = dir() else {
                std::process::exit(1);
            };
            let run = Run {
                dir,
                token: String::new(),
            };
            match fs::remove_file(run.dir.join("run")) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => std::process::exit(1),
            }
            for _ in 0..150 {
                if !alive(&run, "desktop") && !alive(&run, "watchdog") {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            std::process::exit(1);
        }
        if let Some(index) = args.iter().position(|arg| arg == "--watchdog") {
            let result = dir().and_then(|dir| {
                let token = args.get(index + 1).ok_or("Missing guard token")?.clone();
                watchdog(Run { dir, token })
            });
            if let Err(error) = result {
                eprintln!("Watchdog: {error}");
            }
            return true;
        }
        if let Some(index) = args.iter().position(|arg| arg == "--guard-resume") {
            let valid = dir().is_ok_and(|dir| {
                args.get(index + 1).is_some_and(|token| {
                    active(&Run {
                        dir,
                        token: token.clone(),
                    })
                })
            });
            return !valid;
        }
        false
    }
    pub(super) fn start(app: &AppHandle) -> Result<(), String> {
        if cfg!(debug_assertions) && std::env::var("CHORD_CONTROL_TEST_GUARD").as_deref() != Ok("1")
        {
            return Ok(());
        }
        let mut session = crate::sync::lock(&SESSION);
        if session.is_some() {
            return Ok(());
        }
        let dir = dir()?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let args: Vec<String> = std::env::args().collect();
        let resumed = args
            .iter()
            .position(|arg| arg == "--guard-resume")
            .and_then(|index| args.get(index + 1))
            .cloned();
        let token = resumed
            .filter(|token| {
                active(&Run {
                    dir: dir.clone(),
                    token: token.clone(),
                })
            })
            .unwrap_or_else(|| {
                format!(
                    "{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
            });
        let run = Run { dir, token };
        record(&run, "desktop")?;
        fs::write(run.dir.join("run"), &run.token).map_err(|e| e.to_string())?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let monitor_run = run.clone();
        let monitor_cancel = cancelled.clone();
        let app = app.clone();
        let monitor = std::thread::spawn(move || {
            let run = monitor_run;
            let mut budget = Budget::default();
            let mut exhausted = false;
            while active(&run) && !monitor_cancel.load(Ordering::SeqCst) {
                if exhausted || alive(&run, "watchdog") {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                let Some(delay) = budget.next() else {
                    exhausted = true;
                    log(&run, "Watchdog restart limit reached");
                    crate::desktop::report(&app, "守护进程连续异常，请重新启动程序");
                    continue;
                };
                if !wait_active(&run, delay) {
                    break;
                }
                if alive(&run, "watchdog") {
                    continue;
                }
                match command().and_then(|mut cmd| {
                    cmd.args(["--watchdog", &run.token])
                        .spawn()
                        .map_err(|e| e.to_string())
                }) {
                    Ok(mut child) => {
                        while active(&run) && !monitor_cancel.load(Ordering::SeqCst) {
                            match child.try_wait() {
                                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                                Ok(Some(_)) => break,
                                Err(error) => {
                                    log(&run, &error.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    Err(error) => log(&run, &error),
                }
            }
            if !monitor_cancel.load(Ordering::SeqCst) {
                // A maintenance command revoked this session. Quit from a separate thread so
                // stop() can join the monitor without joining itself.
                tauri::async_runtime::spawn_blocking(move || crate::controller::quit(&app));
            }
        });
        *session = Some(Session {
            run,
            cancelled,
            monitor,
        });
        Ok(())
    }
    pub(super) fn stop() {
        let mut session = crate::sync::lock(&SESSION);
        if let Some(session) = session.take() {
            session.cancelled.store(true, Ordering::SeqCst);
            revoke(&session.run);
            let _ = session.monitor.join();
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn restart_budget_stops_crash_loops() {
            let mut budget = Budget::default();
            for _ in 0..5 {
                assert!(budget.next().is_some());
            }
            assert!(budget.next().is_none());
        }
    }
}
pub(crate) fn handle_cli() -> bool {
    #[cfg(windows)]
    {
        windows::handle_cli()
    }
    #[cfg(not(windows))]
    {
        false
    }
}
pub(crate) fn start(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::start(app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}
pub(crate) fn stop() {
    #[cfg(windows)]
    windows::stop();
}
