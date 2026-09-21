//! Preserve the current token and let revocable guard sessions own peer lifetime.
use crate::sync::Cancellation;
use std::{
    ffi::{OsStr, OsString},
    os::windows::{ffi::OsStrExt, process::CommandExt},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use windows::{
    core::PCWSTR,
    Win32::{
        System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        },
        UI::Shell::{
            ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
            SHELLEXECUTEINFOW,
        },
    },
};

pub(crate) struct Apartment;
impl Apartment {
    pub fn new() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok() }
            .map_err(|e| e.to_string())?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
fn wide(value: &OsStr) -> Result<Vec<u16>, String> {
    let mut text: Vec<_> = value.encode_wide().collect();
    if text.contains(&0) {
        return Err("Invalid launch argument".into());
    }
    text.push(0);
    Ok(text)
}
/// CRT / CommandLineToArgvW quoting; shell metacharacters are never interpreted.
pub(crate) fn parameters(args: &[OsString]) -> Vec<u16> {
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
/// Only the initial low-integrity launch requests UAC. No credentials or policy changes.
pub(crate) fn runas(args: Vec<OsString>, timeout: Duration) -> Result<(), String> {
    let expected = crate::elevation::current()?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("uac-launch".into())
        .spawn(move || {
            let result = (|| {
                let _apartment = Apartment::new()?;
                let file = wide(executable.as_os_str())?;
                let directory = wide(
                    executable
                        .parent()
                        .ok_or("Executable directory missing")?
                        .as_os_str(),
                )?;
                if args.iter().any(|v| v.encode_wide().any(|ch| ch == 0)) {
                    return Err("Invalid launch argument".into());
                }
                let mut parameters = parameters(&args);
                parameters.push(0);
                let verb = wide(OsStr::new("runas"))?;
                let mut info = SHELLEXECUTEINFOW {
                    cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                    fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    lpVerb: PCWSTR(verb.as_ptr()),
                    lpFile: PCWSTR(file.as_ptr()),
                    lpParameters: PCWSTR(parameters.as_ptr()),
                    lpDirectory: PCWSTR(directory.as_ptr()),
                    nShow: 0,
                    ..Default::default()
                };
                unsafe { ShellExecuteExW(&mut info) }.map_err(|e| e.to_string())?;
                if info.hProcess.0.is_null() {
                    return Err("Elevation did not return a process handle".into());
                }
                let handle = crate::native::process::Handle(info.hProcess.0);
                let actual = crate::elevation::inspect(handle.0)?;
                crate::updater::diagnostics::record(
                    "elevation_child_token",
                    None,
                    serde_json::json!({"token":actual,"ownerSid":expected.sid}),
                );
                if actual.sid != expected.sid
                    || !actual.high()
                    || actual.session_id != expected.session_id
                {
                    return Err("提权结果不是原用户的交互式 HIGH 令牌，已拒绝启动".into());
                }
                Ok(())
            })();
            let _ = send.send(result);
        })
        .map_err(|e| e.to_string())?;
    // The bootstrap exits on timeout. A late child also checks its expiring attempt and SID.
    receive
        .recv_timeout(timeout)
        .map_err(|_| "等待 Windows 提权超时，请手动重试".to_string())?
}

pub(crate) fn launch(mut args: Vec<OsString>, stop: &Cancellation) -> Result<(), String> {
    if stop.is_cancelled() {
        return Err("Peer launch cancelled".into());
    }
    let token = crate::elevation::current()?;
    if !cfg!(debug_assertions) && !token.high() {
        return Err("Guard peer requires HIGH token".into());
    }
    args.extend(["--startup-owner".into(), token.sid.into()]);
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    // Ordinary process termination does not kill a child on Windows. BREAKAWAY additionally
    // prevents inheriting a kill-on-close job. If a restrictive job forbids it, fail visibly;
    // never silently create a guardian whose lifetime is tied to the desktop's job.
    Command::new(&executable)
        .args(args)
        .current_dir(executable.parent().ok_or("Executable directory missing")?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(
            windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB
                | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
        )
        .spawn()
        .map_err(|e| format!("Independent HIGH peer launch failed: {e}"))?;
    // Dropping Child does not terminate it. The target rechecks its token under the session gate.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_round_trip_through_windows_parser() {
        let arguments: Vec<OsString> = [
            "app.exe",
            "",
            "--background",
            "S-1-5-21-1-1001",
            "C:\\路径 空格\\",
            "a\\\"b",
            "& <tag> %USER% ; $(noop)",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        let mut command = parameters(&arguments);
        command.push(0);
        let mut count = 0;
        unsafe {
            let parsed =
                windows_sys::Win32::UI::Shell::CommandLineToArgvW(command.as_ptr(), &mut count);
            assert!(!parsed.is_null());
            let result: Vec<Vec<u16>> = std::slice::from_raw_parts(parsed, count as usize)
                .iter()
                .map(|value| {
                    let mut length = 0;
                    while *value.add(length) != 0 {
                        length += 1;
                    }
                    std::slice::from_raw_parts(*value, length).to_vec()
                })
                .collect();
            windows_sys::Win32::Foundation::LocalFree(parsed.cast());
            assert_eq!(
                result,
                arguments
                    .iter()
                    .map(|v| v.encode_wide().collect::<Vec<_>>())
                    .collect::<Vec<_>>()
            );
        }
    }
}
