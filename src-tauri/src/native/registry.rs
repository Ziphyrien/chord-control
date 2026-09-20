//! Lossless HKCU values. Paths, desired policy and restoration journals belong to plugins.
use super::failures::Failure;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io;
use winreg::{enums::*, RegKey, RegValue};
const MAX_BYTES: usize = 32768;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawValue {
    r#type: u32,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    path: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    path: String,
    name: String,
    value: Value,
}
fn validate(path: &str, name: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 512
        || path.contains(['\0', '/'])
        || path
            .split('\\')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("无效 HKCU 相对路径".into());
    }
    if name.len() > 256 || name.contains('\0') {
        return Err("无效注册表值名称".into());
    }
    Ok(())
}
fn kind(value: u32) -> Result<RegType, String> {
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
    .ok_or("不支持的注册表类型".into())
}
fn failure(api: &'static str, error: io::Error, path: &str, name: &str, rights: u32) -> Failure {
    Failure::io(
        api,
        error,
        json!({"kind":"registry","hive":"HKCU","path":path,"name":name}),
        Some(rights),
    )
}
fn read(request: Read) -> Result<Value, Failure> {
    validate(&request.path, &request.name)?;
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(&request.path, KEY_QUERY_VALUE)
    {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => {
            return Err(failure(
                "RegOpenKeyExW",
                error,
                &request.path,
                &request.name,
                KEY_QUERY_VALUE,
            ))
        }
    };
    match key.get_raw_value(&request.name) {
        Ok(value) if value.bytes.len() <= MAX_BYTES => serde_json::to_value(RawValue {
            r#type: value.vtype as u32,
            bytes: value.bytes,
        })
        .map_err(|e| e.to_string().into()),
        Ok(_) => Err("注册表值过大".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(failure(
            "RegQueryValueExW",
            error,
            &request.path,
            &request.name,
            KEY_QUERY_VALUE,
        )),
    }
}
fn write(request: Write) -> Result<Value, Failure> {
    validate(&request.path, &request.name)?;
    let value: Option<RawValue> =
        serde_json::from_value(request.value).map_err(|e| e.to_string())?;
    if let Some(value) = value {
        if value.bytes.len() > MAX_BYTES {
            return Err("注册表值过大".into());
        }
        let raw = RegValue {
            vtype: kind(value.r#type)?,
            bytes: value.bytes,
        };
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags(&request.path, KEY_SET_VALUE)
            .map_err(|e| {
                failure(
                    "RegCreateKeyExW",
                    e,
                    &request.path,
                    &request.name,
                    KEY_SET_VALUE,
                )
            })?;
        key.set_raw_value(&request.name, &raw).map_err(|e| {
            failure(
                "RegSetValueExW",
                e,
                &request.path,
                &request.name,
                KEY_SET_VALUE,
            )
        })?;
    } else {
        // Deleting an absent value/key must not create a key as a side effect.
        let key = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&request.path, KEY_SET_VALUE)
        {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(error) => {
                return Err(failure(
                    "RegOpenKeyExW",
                    error,
                    &request.path,
                    &request.name,
                    KEY_SET_VALUE,
                ))
            }
        };
        match key.delete_value(&request.name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(failure(
                    "RegDeleteValueW",
                    error,
                    &request.path,
                    &request.name,
                    KEY_SET_VALUE,
                ))
            }
        }
    }
    Ok(Value::Null)
}
pub(super) fn execute(operation: &str, input: &Value) -> Result<Value, Failure> {
    match operation {
        "registry.read" => read(serde_json::from_value(input.clone()).map_err(|e| e.to_string())?),
        "registry.write" => {
            write(serde_json::from_value(input.clone()).map_err(|e| e.to_string())?)
        }
        _ => Err("未知注册表操作".into()),
    }
}
