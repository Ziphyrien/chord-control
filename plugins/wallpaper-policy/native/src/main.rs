#![doc = "Signed wallpaper-policy native asset: bounded wallpaper and HKCU operations only."]

#[cfg(not(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")))]
compile_error!("chord-wallpaper supports x86_64-pc-windows-msvc only");

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    ffi::{OsStr, c_void},
    io::{self, Read, Write},
    os::windows::ffi::OsStrExt,
    path::Path,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, SPIF_UPDATEINIFILE,
    SendNotifyMessageW, SystemParametersInfoW, WM_SETTINGCHANGE,
};
use winreg::{RegKey, RegValue, enums::*};

const INPUT_LIMIT: usize = 32 * 1024;
const OUTPUT_LIMIT: usize = 64 * 1024;
const MAX_REGISTRY_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    format: u32,
    operation: String,
    input: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawValue {
    r#type: u32,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetWallpaper {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryRead {
    path: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryWrite {
    path: String,
    name: String,
    value: Value,
}

fn failure(stage: &'static str, error: impl Into<String>) -> Value {
    json!({"format": 1, "ok": false, "stage": stage, "error": error.into()})
}

fn registry_failure(
    api: &'static str,
    error: std::io::Error,
    path: &str,
    name: &str,
    rights: u32,
) -> Value {
    json!({
        "format": 1,
        "ok": false,
        "stage": "windows",
        "api": api,
        "code": error.raw_os_error(),
        "target": {"kind": "registry", "hive": "HKCU", "path": path, "name": name},
        "desiredAccess": rights,
        "error": format!("{api}: {error}"),
    })
}

fn success(value: Value) -> Value {
    json!({"format": 1, "ok": true, "value": value})
}

fn read_request() -> Result<Request, Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take((INPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| failure("input.read", error.to_string()))?;
    if bytes.len() > INPUT_LIMIT {
        return Err(failure("input.size", "输入超过 32768 字节"));
    }
    let request: Request = serde_json::from_slice(&bytes)
        .map_err(|error| failure("input.schema", error.to_string()))?;
    if request.format != 1 {
        return Err(failure("input.format", "不支持的原生协议版本"));
    }
    Ok(request)
}

fn wallpaper_get(input: Value) -> Result<Value, Value> {
    if !input.is_null() {
        return Err(failure("input.schema", "wallpaper.get 不接受输入"));
    }
    let mut path = vec![0_u16; 32768];
    if unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            path.len() as u32,
            path.as_mut_ptr().cast::<c_void>(),
            0,
        )
    } == 0
    {
        return Err(failure(
            "windows",
            std::io::Error::last_os_error().to_string(),
        ));
    }
    let end = path
        .iter()
        .position(|character| *character == 0)
        .ok_or_else(|| failure("windows", "壁纸路径未以 NUL 结尾"))?;
    Ok(json!(String::from_utf16_lossy(&path[..end])))
}

fn wallpaper_set(input: Value) -> Result<Value, Value> {
    let request: SetWallpaper = serde_json::from_value(input)
        .map_err(|error| failure("input.schema", error.to_string()))?;
    if request.path.contains('\0')
        || request.path.encode_utf16().count() >= 32768
        || (!request.path.is_empty()
            && (!Path::new(&request.path).is_absolute() || !Path::new(&request.path).is_file()))
    {
        return Err(failure("input.validation", "无效壁纸路径"));
    }
    let mut path: Vec<u16> = OsStr::new(&request.path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            path.as_mut_ptr().cast::<c_void>(),
            SPIF_UPDATEINIFILE,
        )
    } == 0
    {
        return Err(failure(
            "windows",
            std::io::Error::last_os_error().to_string(),
        ));
    }
    unsafe {
        SendNotifyMessageW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            SPI_SETDESKWALLPAPER as usize,
            0,
        );
    }
    Ok(Value::Null)
}

fn validate_registry(path: &str, name: &str) -> Result<(), String> {
    if path.is_empty()
        || path.encode_utf16().count() > 512
        || path.contains(['\0', '/'])
        || path
            .split('\\')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("无效 HKCU 相对路径".into());
    }
    if name.encode_utf16().count() > 256 || name.contains('\0') {
        return Err("无效注册表值名称".into());
    }
    Ok(())
}

fn registry_kind(value: u32) -> Result<RegType, String> {
    [
        REG_NONE,
        REG_SZ,
        REG_EXPAND_SZ,
        REG_BINARY,
        REG_DWORD,
        REG_DWORD_BIG_ENDIAN,
        REG_LINK,
        REG_MULTI_SZ,
        REG_RESOURCE_LIST,
        REG_FULL_RESOURCE_DESCRIPTOR,
        REG_RESOURCE_REQUIREMENTS_LIST,
        REG_QWORD,
    ]
    .into_iter()
    .find(|kind| kind.clone() as u32 == value)
    .ok_or_else(|| "不支持的注册表类型".into())
}

fn registry_read(input: Value) -> Result<Value, Value> {
    let request: RegistryRead = serde_json::from_value(input)
        .map_err(|error| failure("input.schema", error.to_string()))?;
    validate_registry(&request.path, &request.name)
        .map_err(|error| failure("input.validation", error))?;
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(&request.path, KEY_QUERY_VALUE)
    {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => {
            return Err(registry_failure(
                "RegOpenKeyExW",
                error,
                &request.path,
                &request.name,
                KEY_QUERY_VALUE,
            ));
        }
    };
    match key.get_raw_value(&request.name) {
        Ok(value) if value.bytes.len() <= MAX_REGISTRY_BYTES => serde_json::to_value(RawValue {
            r#type: value.vtype as u32,
            bytes: value.bytes,
        })
        .map_err(|error| failure("output.schema", error.to_string())),
        Ok(_) => Err(failure("input.validation", "注册表值过大")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(registry_failure(
            "RegQueryValueExW",
            error,
            &request.path,
            &request.name,
            KEY_QUERY_VALUE,
        )),
    }
}

fn registry_write(input: Value) -> Result<Value, Value> {
    let request: RegistryWrite = serde_json::from_value(input)
        .map_err(|error| failure("input.schema", error.to_string()))?;
    validate_registry(&request.path, &request.name)
        .map_err(|error| failure("input.validation", error))?;
    let value: Option<RawValue> = serde_json::from_value(request.value)
        .map_err(|error| failure("input.schema", error.to_string()))?;
    if let Some(value) = value {
        if value.bytes.len() > MAX_REGISTRY_BYTES {
            return Err(failure("input.validation", "注册表值过大"));
        }
        let vtype =
            registry_kind(value.r#type).map_err(|error| failure("input.validation", error))?;
        let raw = RegValue {
            vtype,
            bytes: value.bytes,
        };
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags(&request.path, KEY_SET_VALUE)
            .map_err(|error| {
                registry_failure(
                    "RegCreateKeyExW",
                    error,
                    &request.path,
                    &request.name,
                    KEY_SET_VALUE,
                )
            })?;
        key.set_raw_value(&request.name, &raw).map_err(|error| {
            registry_failure(
                "RegSetValueExW",
                error,
                &request.path,
                &request.name,
                KEY_SET_VALUE,
            )
        })?;
    } else {
        let key = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&request.path, KEY_SET_VALUE)
        {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(error) => {
                return Err(registry_failure(
                    "RegOpenKeyExW",
                    error,
                    &request.path,
                    &request.name,
                    KEY_SET_VALUE,
                ));
            }
        };
        match key.delete_value(&request.name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(registry_failure(
                    "RegDeleteValueW",
                    error,
                    &request.path,
                    &request.name,
                    KEY_SET_VALUE,
                ));
            }
        }
    }
    Ok(Value::Null)
}

fn execute(request: Request) -> Result<Value, Value> {
    match request.operation.as_str() {
        "wallpaper.get" => wallpaper_get(request.input),
        "wallpaper.set" => wallpaper_set(request.input),
        "registry.read" => registry_read(request.input),
        "registry.write" => registry_write(request.input),
        _ => Err(failure("input.operation", "未知壁纸原生操作")),
    }
}

fn main() {
    let response = match read_request() {
        Ok(request) => execute(request).map_or_else(|error| error, success),
        Err(error) => error,
    };
    let mut bytes = serde_json::to_vec(&response).expect("JSON serialization cannot fail");
    if bytes.len() + 1 > OUTPUT_LIMIT {
        bytes = serde_json::to_vec(&failure("output.size", "输出超过 65536 字节"))
            .expect("JSON serialization cannot fail");
    }
    bytes.push(b'\n');
    let _ = io::stdout().lock().write_all(&bytes);
}
