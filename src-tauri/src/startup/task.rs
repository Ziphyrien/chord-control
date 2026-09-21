//! COM runs in a bounded, noninteractive copy of this executable, never in a script host.
use super::policy;
use serde_json::json;
use std::{
    io::Read,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::VARIANT_BOOL,
        System::{
            Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            TaskScheduler::{
                IExecAction, ILogonTrigger, IRegisteredTask, ITaskFolder, ITaskService,
                TaskScheduler, TASK_CREATE_OR_UPDATE, TASK_IGNORE_REGISTRATION_TRIGGERS,
                TASK_LOGON_INTERACTIVE_TOKEN, TASK_LOGON_TYPE, TASK_RUNLEVEL_HIGHEST,
                TASK_RUNLEVEL_TYPE,
            },
            Variant::VARIANT,
        },
    },
};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE},
    RegKey,
};

static ACCESS: Mutex<()> = Mutex::new(());
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const ENTRY: &str = "Chord Control";
fn error(value: windows::core::Error) -> String {
    value.to_string()
}

pub(super) fn request(operation: &str) -> Result<bool, String> {
    let _access = ACCESS
        .try_lock()
        .map_err(|_| "启动设置正在处理，请稍后重试")?;
    let token = crate::elevation::current()?;
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args(["--startup-task", operation, "--startup-owner", &token.sid])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let result = (|| loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(format!("Startup helper exited: {status}"));
            }
            let mut output = Vec::new();
            child
                .stdout
                .take()
                .ok_or("Startup helper output missing")?
                .take(8193)
                .read_to_end(&mut output)
                .map_err(|e| e.to_string())?;
            if output.len() > 8192 {
                return Err("Startup helper output exceeded limit".into());
            }
            return serde_json::from_slice::<Result<bool, String>>(&output)
                .map_err(|e| e.to_string())?;
        }
        if Instant::now() >= deadline {
            return Err("Windows 启动任务服务响应超时".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    if operation != "query" {
        crate::updater::diagnostics::record(
            "startup_task_outcome",
            None,
            json!({"operation":operation,"ok":result.is_ok(),"enabled":result.as_ref().ok(),"error":result.as_ref().err()}),
        );
    }
    result
}

pub(super) fn handle_cli() -> Result<bool, String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !args.iter().any(|v| v == "--startup-task") {
        return Ok(false);
    }
    // No arbitrary task name, executable, XML, directory, credentials, or additional role.
    if args.len() != 4 || args[0] != "--startup-task" || args[2] != "--startup-owner" {
        return Err("Invalid startup helper arguments".into());
    }
    let operation = args[1].to_str().ok_or("Invalid startup operation")?;
    let result = execute(operation);
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(true)
}
struct Spec {
    sid: String,
    executable: PathBuf,
    name: String,
}
impl Spec {
    fn current() -> Result<Self, String> {
        let sid = crate::elevation::current()?.sid;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let name = policy::task_name(
            &sid,
            executable.parent().ok_or("Executable directory missing")?,
        )?;
        Ok(Self {
            sid,
            executable,
            name,
        })
    }
}
struct Task {
    enabled: bool,
    current_action: bool,
}
fn inspect(task: &IRegisteredTask, spec: &Spec) -> Result<Task, String> {
    unsafe {
        let definition = task.Definition().map_err(error)?;
        let principal = definition.Principal().map_err(error)?;
        let mut sid = BSTR::new();
        let mut logon = TASK_LOGON_TYPE::default();
        let mut level = TASK_RUNLEVEL_TYPE::default();
        principal.UserId(&mut sid).map_err(error)?;
        principal.LogonType(&mut logon).map_err(error)?;
        principal.RunLevel(&mut level).map_err(error)?;
        if sid.to_string() != spec.sid
            || logon != TASK_LOGON_INTERACTIVE_TOKEN
            || level != TASK_RUNLEVEL_HIGHEST
        {
            return Err("Existing startup task has a different security principal".into());
        }
        let actions = definition.Actions().map_err(error)?;
        let mut count = 0;
        actions.Count(&mut count).map_err(error)?;
        if count != 1 {
            return Err("Existing startup task has unexpected actions".into());
        }
        let action: IExecAction = actions.get_Item(1).and_then(|v| v.cast()).map_err(error)?;
        let mut executable = BSTR::new();
        let mut arguments = BSTR::new();
        let mut directory = BSTR::new();
        action.Path(&mut executable).map_err(error)?;
        action.Arguments(&mut arguments).map_err(error)?;
        action.WorkingDirectory(&mut directory).map_err(error)?;
        let executable = PathBuf::from(executable.to_string());
        if executable.parent().map(policy::normalized)
            != spec.executable.parent().map(policy::normalized)
            || arguments.to_string() != policy::arguments(&spec.sid)?
        {
            return Err("Existing startup task points outside this installation".into());
        }
        let triggers = definition.Triggers().map_err(error)?;
        triggers.Count(&mut count).map_err(error)?;
        if count != 1 {
            return Err("Existing startup task has unexpected triggers".into());
        }
        let trigger: ILogonTrigger = triggers.get_Item(1).and_then(|v| v.cast()).map_err(error)?;
        let mut owner = BSTR::new();
        let mut enabled = VARIANT_BOOL::default();
        trigger.UserId(&mut owner).map_err(error)?;
        trigger.Enabled(&mut enabled).map_err(error)?;
        if owner.to_string() != spec.sid {
            return Err("Existing startup trigger belongs to another user".into());
        }
        Ok(Task {
            enabled: task.Enabled().map_err(error)?.as_bool() && enabled.as_bool(),
            current_action: policy::normalized(&executable) == policy::normalized(&spec.executable)
                && policy::normalized(Path::new(&directory.to_string()))
                    == policy::normalized(spec.executable.parent().unwrap()),
        })
    }
}
fn find(folder: &ITaskFolder, spec: &Spec) -> Result<Option<Task>, String> {
    match unsafe { folder.GetTask(&BSTR::from(spec.name.as_str())) } {
        Ok(task) => inspect(&task, spec).map(Some),
        Err(e) if e.code().0 as u32 == 0x80070002 => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn legacy() -> Result<bool, String> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let key = match root.open_subkey_with_flags(RUN, KEY_READ) {
        Ok(key) => key,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    match key.get_value::<String, _>(ENTRY) {
        Ok(value) if !value.is_empty() => {}
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    }
    match root
        .open_subkey_with_flags(APPROVED, KEY_READ)
        .and_then(|key| key.get_raw_value(ENTRY))
    {
        Ok(value) => Ok(!matches!(value.bytes.first(), Some(3 | 7))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
fn remove_legacy() -> Result<(), String> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    for path in [RUN, APPROVED] {
        match root
            .open_subkey_with_flags(path, KEY_SET_VALUE)
            .and_then(|key| key.delete_value(ENTRY))
        {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn execute(operation: &str) -> Result<bool, String> {
    if !matches!(
        operation,
        "query" | "ensure" | "enable" | "disable" | "remove"
    ) {
        return Err("Unknown startup operation".into());
    }
    // The owning user may delete their task without elevation under the scheduler ACL.
    // Cleanup never requests UAC or grants new access; access denied remains a hard error.
    if matches!(operation, "ensure" | "enable" | "disable") && !crate::elevation::current()?.high()
    {
        return Err("启动任务需要原用户的 HIGH 管理员令牌".into());
    }
    let spec = Spec::current()?;
    let _apartment = crate::shell_launch::Apartment::new()?;
    let service: ITaskService =
        unsafe { CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER) }.map_err(error)?;
    let empty = VARIANT::default();
    unsafe { service.Connect(&empty, &empty, &empty, &empty) }.map_err(error)?;
    let folder = unsafe { service.GetFolder(&BSTR::from("\\")) }.map_err(error)?;
    let task = find(&folder, &spec)?;
    if operation == "query" {
        return Ok(task.is_some_and(|v| v.enabled && v.current_action));
    }
    let directory =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?)
            .join("ChordControl");
    let marker = directory.join("first-run-complete");
    let enabled = match operation {
        "enable" => true,
        "disable" | "remove" => false,
        _ => policy::desired(
            task.as_ref().map(|v| v.enabled),
            legacy()?,
            marker.try_exists().map_err(|e| e.to_string())?,
        ),
    };
    if enabled {
        let registered = unsafe {
            folder.RegisterTask(
                &BSTR::from(spec.name.as_str()),
                &BSTR::from(policy::xml(&spec.sid, &spec.executable)?),
                TASK_CREATE_OR_UPDATE.0 | TASK_IGNORE_REGISTRATION_TRIGGERS.0,
                &VARIANT::from(spec.sid.as_str()),
                &empty,
                TASK_LOGON_INTERACTIVE_TOKEN,
                &empty,
            )
        }
        .map_err(error)?;
        let verified = inspect(&registered, &spec)?;
        if !verified.enabled || !verified.current_action {
            return Err("Startup task registration did not match requested state".into());
        }
    } else if task.is_some() {
        unsafe { folder.DeleteTask(&BSTR::from(spec.name.as_str()), 0) }.map_err(error)?;
    }
    // Only remove the old Run value after successful registration/deletion, preserving its
    // choice on registration errors. No second logon launch remains after a successful change.
    remove_legacy()?;
    if operation != "remove" {
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        std::fs::write(marker, b"1").map_err(|e| e.to_string())?;
    }
    let actual = find(&folder, &spec)?.is_some_and(|v| v.enabled && v.current_action);
    if actual != enabled || legacy()? {
        return Err("Startup setting verification failed".into());
    }
    Ok(actual)
}
