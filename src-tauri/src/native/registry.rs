use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io;
use winreg::{enums::*, RegKey, RegValue};

#[derive(Deserialize, Serialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct RawValue {
    r#type: u32,
    bytes: Vec<u8>,
}
fn kind(value: u32) -> Result<RegType, String> {
    let types = [
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
    ];
    types
        .into_iter()
        .find(|t| t.clone() as u32 == value)
        .ok_or("不支持的注册表类型".into())
}
fn read(path: &str, name: &str) -> Result<Option<RawValue>, String> {
    let result = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(path)
        .and_then(|key| key.get_raw_value(name));
    match result {
        Ok(value) => Ok(Some(RawValue {
            r#type: value.vtype as u32,
            bytes: value.bytes,
        })),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn write(path: &str, name: &str, value: Option<RawValue>) -> Result<(), String> {
    if let Some(value) = value {
        if value.bytes.len() > 32768 {
            return Err("注册表值过大".into());
        }
        let raw = RegValue {
            vtype: kind(value.r#type)?,
            bytes: value.bytes,
        };
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(path)
            .map_err(|e| e.to_string())?;
        key.set_raw_value(name, &raw).map_err(|e| e.to_string())
    } else {
        match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(path, KEY_SET_VALUE)
            .and_then(|key| key.delete_value(name))
        {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
pub(super) fn execute(operation: &str, input: &Value) -> Result<Value, String> {
    let path = input["path"]
        .as_str()
        .filter(|p| !p.is_empty() && p.len() <= 512 && !p.contains('\0'))
        .ok_or("无效注册表路径")?;
    let name = input["name"]
        .as_str()
        .filter(|p| p.len() <= 256 && !p.contains('\0'))
        .ok_or("无效注册表值名称")?;
    if operation == "registry.read" {
        return serde_json::to_value(read(path, name)?).map_err(|e| e.to_string());
    }
    let value = serde_json::from_value(input.get("value").ok_or("缺少注册表值")?.clone())
        .map_err(|e| e.to_string())?;
    write(path, name, value)?;
    Ok(json!(null))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_registry_values_restore_and_missing_stays_missing() {
        let path = format!("Software\\ChordControl\\Tests\\{}", std::process::id());
        assert_eq!(read(&path, "value").unwrap(), None);
        write(
            &path,
            "value",
            Some(RawValue {
                r#type: 3,
                bytes: vec![0, 255, 10],
            }),
        )
        .unwrap();
        assert_eq!(
            read(&path, "value").unwrap().unwrap().bytes,
            vec![0, 255, 10]
        );
        write(&path, "value", None).unwrap();
        assert_eq!(read(&path, "value").unwrap(), None);
        RegKey::predef(HKEY_CURRENT_USER)
            .delete_subkey_all(&path)
            .unwrap();
    }
}
