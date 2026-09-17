//! Explorer owns peer launches. No direct watchdog/desktop parent-child fallback.
use crate::sync::{lock, Cancellation};
use std::{
    ffi::{OsStr, OsString},
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        System::{
            Com::{
                CoCancelCall, CoCreateInstance, CoDisableCallCancellation,
                CoEnableCallCancellation, CoInitializeEx, CoUninitialize, IDispatch,
                IServiceProvider, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
                COINIT_DISABLE_OLE1DDE,
            },
            Variant::VARIANT,
        },
        UI::Shell::{
            IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellWindows,
            SID_STopLevelBrowser, ShellWindows, CSIDL_DESKTOP, SVGIO_BACKGROUND, SWC_DESKTOP,
            SWFO_NEEDDISPATCH,
        },
    },
};

static BUSY: AtomicBool = AtomicBool::new(false);
struct WorkerSlot;
impl Drop for WorkerSlot {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}
struct CallTarget(Arc<Mutex<Option<u32>>>);
impl Drop for CallTarget {
    fn drop(&mut self) {
        *lock(&self.0) = None;
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            let _ = CoDisableCallCancellation(None);
            CoUninitialize();
        }
    }
}
fn bstr(value: &OsStr) -> BSTR {
    BSTR::from_wide(&value.encode_wide().collect::<Vec<_>>())
}

/// CommandLineToArgvW / CRT quoting, including empty strings and trailing backslashes.
fn parameters(args: &[OsString]) -> Vec<u16> {
    let mut output = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if index > 0 {
            output.push(b' ' as u16);
        }
        output.push(b'"' as u16);
        let mut slashes = 0;
        for ch in arg.encode_wide() {
            if ch == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            let count = if ch == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            };
            output.extend(std::iter::repeat_n(b'\\' as u16, count));
            output.push(ch);
            slashes = 0;
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        output.push(b'"' as u16);
    }
    output
}
fn execute(executable: &Path, args: &[OsString], cancel: &Cancellation) -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok() }
        .map_err(|e| e.to_string())?;
    let _apartment = Apartment;
    unsafe { CoEnableCallCancellation(None) }.map_err(|e| e.to_string())?;
    let check = || {
        if cancel.is_cancelled() {
            Err("Explorer launch cancelled".to_string())
        } else {
            Ok(())
        }
    };
    // Use the desktop shell view, not a separately created Shell.Application instance.
    // Each RPC boundary is followed by cancellation validation before the next call.
    unsafe {
        check()?;
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)
            .map_err(|e| e.to_string())?;
        check()?;
        let mut hwnd = 0;
        let desktop = windows
            .FindWindowSW(
                &VARIANT::from(CSIDL_DESKTOP as i32),
                &VARIANT::default(),
                SWC_DESKTOP,
                &mut hwnd,
                SWFO_NEEDDISPATCH,
            )
            .map_err(|e| e.to_string())?;
        check()?;
        let provider: IServiceProvider = desktop.cast().map_err(|e| e.to_string())?;
        let browser: IShellBrowser = provider
            .QueryService(&SID_STopLevelBrowser)
            .map_err(|e| e.to_string())?;
        check()?;
        let view = browser.QueryActiveShellView().map_err(|e| e.to_string())?;
        check()?;
        let dispatch: IDispatch = view
            .GetItemObject(SVGIO_BACKGROUND)
            .map_err(|e| e.to_string())?;
        let folder: IShellFolderViewDual = dispatch.cast().map_err(|e| e.to_string())?;
        check()?;
        let shell: IShellDispatch2 = folder
            .Application()
            .and_then(|v| v.cast())
            .map_err(|e| e.to_string())?;
        check()?;
        shell
            .ShellExecute(
                &bstr(executable.as_os_str()),
                &VARIANT::from(BSTR::from_wide(&parameters(args))),
                &VARIANT::from(bstr(
                    executable
                        .parent()
                        .ok_or("Executable has no directory")?
                        .as_os_str(),
                )),
                &VARIANT::from("open"),
                &VARIANT::from(0_i32),
            )
            .map_err(|e| e.to_string())
    }
}

pub(crate) fn launch(args: Vec<OsString>, stop: &Cancellation) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if args.iter().any(|arg| arg.encode_wide().any(|ch| ch == 0)) {
        return Err("Invalid launch argument".into());
    }
    if stop.is_cancelled() {
        return Err("Explorer launch cancelled".into());
    }
    if BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Previous Explorer call has not returned".into());
    }
    let slot = WorkerSlot;
    let cancel = Cancellation::default();
    let worker_cancel = cancel.clone();
    let thread_id = Arc::new(Mutex::new(None));
    let worker_id = thread_id.clone();
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("explorer-launch".into())
        .spawn(move || {
            let _slot = slot;
            let target = CallTarget(worker_id);
            *lock(&target.0) =
                Some(unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() });
            let result = execute(&executable, &args, &worker_cancel);
            drop(target);
            let _ = send.send(result);
        })
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match receive.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Explorer launch worker exited".into())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if stop.is_cancelled() || Instant::now() >= deadline {
            cancel.cancel();
            // Keep the target locked through cancellation. The worker cannot finish
            // and release/reuse this thread ID until it clears the same target.
            if let Some(id) = *lock(&thread_id) {
                unsafe {
                    let _ = CoCancelCall(id, 0);
                }
            }
            // COM cancellation is cooperative. Never join an unresponsive RPC worker;
            // BUSY stays set until it actually exits, bounding abandoned work to one.
            // Any late ShellExecute must still pass the peer's revocable session check.
            return Err("Explorer launch cancelled or timed out".into());
        }
    }
}
