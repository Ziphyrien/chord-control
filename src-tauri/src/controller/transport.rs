//! Bounded line transport. Child ownership is separate from potentially blocking pipe I/O.
use crate::sync::Cancellation;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub(super) const MAX_FRAME: usize = 2 * 1024 * 1024;
pub(super) enum Event {
    Frame(Vec<u8>),
    Fault(String),
}
pub(super) struct Transport {
    child: Child,
    pub input: SyncSender<Vec<u8>>,
    pub events: Receiver<Event>,
    cancel: Cancellation,
    workers: Vec<JoinHandle<()>>,
    drained: Option<bool>,
}
fn pipe_lines(
    reader: impl Read,
    limit: usize,
    cancel: &Cancellation,
    mut consume: impl FnMut(Vec<u8>) -> bool,
) -> Result<(), String> {
    let mut reader = BufReader::new(reader);
    while !cancel.is_cancelled() {
        let mut line = Vec::new();
        // Take bounds allocation even if the sidecar never emits a newline.
        let count = reader
            .by_ref()
            .take((limit + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        if count > limit {
            return Err("Controller frame exceeds size limit".into());
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if !line.is_empty() && !consume(line) {
            return Ok(());
        }
    }
    Ok(())
}
fn publish(sender: &SyncSender<Event>, cancel: &Cancellation, mut event: Event) -> bool {
    loop {
        match sender.try_send(event) {
            Ok(()) => return true,
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
            Err(mpsc::TrySendError::Full(value)) => event = value,
        }
        if !cancel.wait(Duration::from_millis(10)) {
            return false;
        }
    }
}
impl Transport {
    pub fn spawn(data: &Path) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let directory = executable.parent().ok_or("Executable has no directory")?;
        let sidecar = directory.join(if cfg!(windows) {
            "plugin-controller.exe"
        } else {
            "plugin-controller"
        });
        let mut command = Command::new(sidecar);
        command
            .arg("--stdio")
            .env("CHORD_CONTROL_DATA_DIR", data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|e| format!("无法启动控制器: {e}"))?;
        let (input, receive) = mpsc::sync_channel::<Vec<u8>>(64);
        let (events, output) = mpsc::sync_channel(64);
        let mut transport = Self {
            child,
            input,
            events: output,
            cancel: Cancellation::default(),
            workers: Vec::new(),
            drained: None,
        };
        // Drop cancels partial initialization if any thread creation fails.
        let mut stdin = transport
            .child
            .stdin
            .take()
            .ok_or("Missing controller stdin")?;
        let stdout = transport
            .child
            .stdout
            .take()
            .ok_or("Missing controller stdout")?;
        let stderr = transport
            .child
            .stderr
            .take()
            .ok_or("Missing controller stderr")?;
        let cancel = transport.cancel.clone();
        let errors = events.clone();
        transport.workers.push(
            std::thread::Builder::new()
                .name("controller-input".into())
                .spawn(move || {
                    while !cancel.is_cancelled() {
                        match receive.recv_timeout(Duration::from_millis(100)) {
                            Ok(bytes) => {
                                if let Err(error) = stdin.write_all(&bytes) {
                                    publish(&errors, &cancel, Event::Fault(error.to_string()));
                                    break;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
                .map_err(|e| e.to_string())?,
        );
        let cancel = transport.cancel.clone();
        let frames = events.clone();
        transport.workers.push(
            std::thread::Builder::new()
                .name("controller-output".into())
                .spawn(move || {
                    let result = pipe_lines(stdout, MAX_FRAME, &cancel, |line| {
                        publish(&frames, &cancel, Event::Frame(line))
                    });
                    if !cancel.is_cancelled() {
                        let message = result
                            .err()
                            .unwrap_or_else(|| "Controller output closed".into());
                        publish(&frames, &cancel, Event::Fault(message));
                    }
                })
                .map_err(|e| e.to_string())?,
        );
        let cancel = transport.cancel.clone();
        let log = data.join("controller-stderr.log");
        transport.workers.push(
            std::thread::Builder::new()
                .name("controller-log".into())
                .spawn(move || {
                    if let Err(error) = pipe_lines(stderr, 64 * 1024, &cancel, |line| {
                        crate::logging::append(&log, &line);
                        true
                    }) {
                        publish(&events, &cancel, Event::Fault(error));
                    }
                })
                .map_err(|e| e.to_string())?,
        );
        Ok(transport)
    }
    pub fn exited(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|e| e.to_string())
    }
    pub fn stop(&mut self) -> bool {
        if let Some(drained) = self.drained {
            return drained;
        }
        self.cancel.cancel();
        let killed = match self.child.try_wait() {
            Ok(Some(_)) => true,
            _ => self.child.kill().is_ok(),
        };
        let deadline = Instant::now() + Duration::from_millis(750);
        while self.workers.iter().any(|worker| !worker.is_finished()) && Instant::now() < deadline {
            #[cfg(windows)]
            {
                use std::os::windows::thread::JoinHandleExt;
                for worker in &self.workers {
                    unsafe {
                        windows_sys::Win32::System::IO::CancelSynchronousIo(worker.as_raw_handle());
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let finished = self.workers.iter().all(JoinHandle::is_finished);
        // A hung filesystem/device driver can ignore cancellation. Never join it, and
        // report failure so the supervisor forbids another generation in this process.
        for worker in self.workers.drain(..) {
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
        let _ = self.child.try_wait();
        self.drained = Some(killed && finished);
        killed && finished
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        if self.drained.is_none() {
            self.stop();
        }
    }
}
