use serde::Serialize;
use serde_json::{json, Value};
use std::{
    mem::size_of,
    process::{Command, Stdio},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE},
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
    let mut path = vec![0u16; 32768];
    let mut len = path.len() as u32;
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel = exit;
    let mut user = exit;
    unsafe {
        if QueryFullProcessImageNameW(handle.0, 0, path.as_mut_ptr(), &mut len) == 0
            || GetProcessTimes(handle.0, &mut created, &mut exit, &mut kernel, &mut user) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok((
        String::from_utf16_lossy(&path[..len as usize]),
        (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string(),
    ))
}
fn session(pid: u32) -> Option<u32> {
    let mut id = 0;
    if unsafe { ProcessIdToSessionId(pid, &mut id) } == 0 {
        None
    } else {
        Some(id)
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
fn list(names: &[String]) -> Result<Vec<Process>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let snapshot = Handle(snapshot);
    let current_session = session(std::process::id()).ok_or("无法查询会话")?;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut result = Vec::new();
    while found != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
        if names.iter().any(|n| n.eq_ignore_ascii_case(&name))
            && session(entry.th32ProcessID) == Some(current_session)
        {
            if let Ok(handle) = open(entry.th32ProcessID, PROCESS_QUERY_LIMITED_INFORMATION) {
                if let Ok((executable, created_at)) = identity(&handle) {
                    result.push(Process {
                        pid: entry.th32ProcessID,
                        parent_pid: entry.th32ParentProcessID,
                        name,
                        executable,
                        created_at,
                    });
                }
            }
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(result)
}
pub(super) fn execute(operation: &str, input: &Value) -> Result<Value, String> {
    match operation {
        "process.list" => {
            let names: Vec<String> =
                serde_json::from_value(input["names"].clone()).map_err(|e| e.to_string())?;
            if names.is_empty()
                || names.len() > 32
                || names
                    .iter()
                    .any(|s| s.len() > 100 || s.contains(['/', '\\']))
            {
                return Err("无效进程名称".into());
            }
            serde_json::to_value(list(&names)?).map_err(|e| e.to_string())
        }
        "process.terminate" => {
            let pid = input["pid"]
                .as_u64()
                .and_then(|id| u32::try_from(id).ok())
                .ok_or("无效 PID")?;
            if pid == std::process::id()
                || session(pid).is_none()
                || session(pid) != session(std::process::id())
            {
                return Err("不允许终止此进程".into());
            }
            let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE)?;
            let (exe, created) = identity(&handle)?;
            if input["createdAt"].as_str() != Some(&created)
                || input["executable"].as_str() != Some(&exe)
            {
                return Err("进程已经变更".into());
            }
            if unsafe { TerminateProcess(handle.0, 1) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Value::Null)
        }
        "process.spawn" => {
            let executable = input["executable"].as_str().ok_or("缺少进程路径")?;
            if !std::path::Path::new(executable).is_absolute()
                || !std::path::Path::new(executable).is_file()
                || executable.contains('\0')
            {
                return Err("进程路径必须是存在的绝对路径".into());
            }
            let args: Vec<String> =
                serde_json::from_value(input["args"].clone()).map_err(|e| e.to_string())?;
            if args.len() > 64 || args.iter().any(|a| a.len() > 4096 || a.contains('\0')) {
                return Err("无效启动参数".into());
            }
            let child = Command::new(executable)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(json!({"pid":child.id()}))
        }
        _ => Err("未知进程操作".into()),
    }
}
