//! Process inventory and identity-bound control using ordinary current-user access rights.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    mem::size_of,
    path::Path,
    process::{Command, Stdio},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        RemoteDesktop::ProcessIdToSessionId,
        Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        },
    },
};

pub(crate) struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub(crate) fn open(pid: u32, rights: u32) -> Result<Handle, String> {
    let handle = unsafe { OpenProcess(rights, 0, pid) };
    if handle.is_null() {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(Handle(handle))
    }
}
pub(crate) fn identity(handle: &Handle) -> Result<(String, String), String> {
    identity_raw(handle.0)
}
/// Borrows a live process handle; ownership stays with Handle or std::process::Child.
fn identity_raw(handle: HANDLE) -> Result<(String, String), String> {
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit = created;
    let mut kernel = created;
    let mut user = created;
    unsafe {
        if QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) == 0
            || GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok((
        String::from_utf16_lossy(&path[..length as usize]),
        ((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)).to_string(),
    ))
}
fn session(pid: u32) -> Result<u32, String> {
    let mut session = 0;
    if unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(session)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Process {
    pid: u32,
    parent_pid: u32,
    name: String,
    executable: String,
    created_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    names: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Terminate {
    pid: u32,
    executable: String,
    created_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Spawn {
    executable: String,
    args: Vec<String>,
}
fn decode<T: serde::de::DeserializeOwned>(input: &Value) -> Result<T, String> {
    serde_json::from_value(input.clone()).map_err(|e| e.to_string())
}
fn list(input: List) -> Result<Value, String> {
    if input.names.is_empty()
        || input.names.len() > 32
        || input
            .names
            .iter()
            .any(|name| name.is_empty() || name.len() > 100 || name.contains(['/', '\\', '\0']))
    {
        return Err("无效进程名称".into());
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let snapshot = Handle(snapshot);
    let current_session = session(std::process::id())?;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut available = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut processes = Vec::new();
    while available != 0 {
        let end = entry
            .szExeFile
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
        if input
            .names
            .iter()
            .any(|wanted| wanted.eq_ignore_ascii_case(&name))
            && session(entry.th32ProcessID).ok() == Some(current_session)
        {
            if let Ok(handle) = open(entry.th32ProcessID, PROCESS_QUERY_LIMITED_INFORMATION) {
                if let Ok((executable, created_at)) = identity(&handle) {
                    processes.push(Process {
                        pid: entry.th32ProcessID,
                        parent_pid: entry.th32ParentProcessID,
                        name,
                        executable,
                        created_at,
                    });
                }
            }
        }
        available = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    let error = unsafe { GetLastError() };
    if error != ERROR_NO_MORE_FILES {
        return Err(std::io::Error::from_raw_os_error(error as i32).to_string());
    }
    serde_json::to_value(processes).map_err(|e| e.to_string())
}
fn terminate(input: Terminate) -> Result<Value, String> {
    if input.pid == 0
        || input.pid == std::process::id()
        || session(input.pid)? != session(std::process::id())?
    {
        return Err("不允许终止此进程".into());
    }
    // The same handle is used for validation and termination, preventing PID reuse races.
    let handle = open(
        input.pid,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
    )?;
    let (executable, created) = identity(&handle)?;
    if !executable.eq_ignore_ascii_case(&input.executable) || created != input.created_at {
        return Err("进程已经变更".into());
    }
    if unsafe { TerminateProcess(handle.0, 1) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Value::Null)
}
fn spawn(input: Spawn) -> Result<Value, String> {
    let path = Path::new(&input.executable);
    if !path.is_absolute()
        || !path.is_file()
        || input.executable.contains('\0')
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err("进程路径必须是存在的绝对可执行文件路径".into());
    }
    if input.args.len() > 64
        || input
            .args
            .iter()
            .any(|arg| arg.len() > 4096 || arg.contains('\0'))
    {
        return Err("无效启动参数".into());
    }
    // Rust uses CreateProcessW, quotes each argument, and does not interpret shell syntax.
    use std::os::windows::io::AsRawHandle;
    let mut child = Command::new(path)
        .args(input.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let (executable, created_at) = match identity_raw(child.as_raw_handle()) {
        Ok(identity) => identity,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    Ok(json!({"pid":child.id(),"createdAt":created_at,"executable":executable}))
}
pub(super) fn execute(operation: &str, input: &Value) -> Result<Value, String> {
    match operation {
        "process.list" => list(decode(input)?),
        "process.terminate" => terminate(decode(input)?),
        "process.spawn" => spawn(decode(input)?),
        _ => Err("未知进程操作".into()),
    }
}
