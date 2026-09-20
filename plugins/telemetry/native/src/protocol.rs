use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Read;

pub const INPUT_LIMIT: usize = 32 * 1024;
pub const OUTPUT_LIMIT: usize = 64 * 1024;
pub const ALLOWED_REGISTRY_ACCESS: u32 = 0x1f;

#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub error: String,
    pub code: u32,
    pub stage: &'static str,
}

pub type Probe<T> = Result<T, Failure>;

impl Failure {
    pub fn new(code: u32, stage: &'static str, error: impl Into<String>) -> Self {
        Self {
            code,
            stage,
            error: error.into(),
        }
    }

    pub fn invalid(stage: &'static str, error: impl Into<String>) -> Self {
        Self::new(87, stage, error)
    }
}

pub fn outcome<T: Serialize>(result: Probe<T>) -> Value {
    match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(failure) => {
            json!({"ok": false, "error": failure.error, "code": failure.code, "stage": failure.stage})
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub format: u32,
    pub processes: Vec<Value>,
    pub registry: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRequest {
    pub role: String,
    pub pid: u32,
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryRequest {
    pub event_id: String,
    pub pid: u32,
    pub created_at: String,
    pub path: String,
    pub name: String,
    pub desired_access: u32,
    pub allow_parent: bool,
}

pub fn read_bounded(reader: impl Read) -> Probe<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((INPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            Failure::new(
                error.raw_os_error().unwrap_or(1117) as u32,
                "input.read",
                "Could not read stdin",
            )
        })?;
    if bytes.len() > INPUT_LIMIT {
        return Err(Failure::new(122, "input.size", "Input exceeds 32768 bytes"));
    }
    Ok(bytes)
}

pub fn parse_request(bytes: &[u8]) -> Probe<Request> {
    if bytes.len() > INPUT_LIMIT {
        return Err(Failure::new(122, "input.size", "Input exceeds 32768 bytes"));
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| {
        Failure::invalid(
            "input.schema",
            "Expected format, processes and registry only, with valid JSON types",
        )
    })?;
    if request.format != 1 {
        return Err(Failure::new(
            50,
            "input.format",
            "Unsupported format; expected 1",
        ));
    }
    if request.processes.len() > 3 || request.registry.len() > 8 {
        return Err(Failure::invalid(
            "input.count",
            "At most 3 processes and 8 registry probes are allowed",
        ));
    }
    Ok(request)
}

fn identifier(value: &str, max: usize, stage: &'static str) -> Probe<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(Failure::invalid(
            stage,
            "Identifier is empty, too long, or contains control characters",
        ));
    }
    Ok(())
}

pub fn filetime(value: &str) -> Probe<u64> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Failure::invalid(
            "process.identity",
            "createdAt must be a decimal FILETIME string",
        ));
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            Failure::invalid(
                "process.identity",
                "createdAt is outside the nonzero u64 range",
            )
        })
}

pub fn match_birth(expected: Option<&str>, actual: u64) -> Probe<()> {
    if let Some(expected) = expected
        && filetime(expected)? != actual
    {
        return Err(Failure::new(
            13,
            "process.identity",
            "PID creation time mismatch; target may have exited or PID was reused",
        ));
    }
    Ok(())
}

pub fn process_request(value: &Value) -> Probe<ProcessRequest> {
    let request: ProcessRequest = serde_json::from_value(value.clone()).map_err(|_| {
        Failure::invalid(
            "process.validate",
            "Invalid or unknown process probe fields",
        )
    })?;
    identifier(&request.role, 64, "process.validate")?;
    if request.pid == 0 {
        return Err(Failure::invalid("process.validate", "pid must be nonzero"));
    }
    if let Some(created_at) = &request.created_at {
        filetime(created_at)?;
    }
    Ok(request)
}

/// Input is a relative key path such as Software\\Vendor, never a hive-qualified path.
/// The empty path denotes the target user's hive root. Length is measured in UTF-16 units.
pub fn registry_path(path: &str) -> Probe<()> {
    if path.encode_utf16().count() > 512 || path.contains(['\0', '/']) {
        return Err(Failure::invalid(
            "registry.validate",
            "Path exceeds 512 UTF-16 units or contains NUL or slash",
        ));
    }
    if path.is_empty() {
        return Ok(());
    }
    let mut components = path.split('\\');
    let first = components.next().unwrap_or_default();
    if matches!(
        first.to_ascii_uppercase().as_str(),
        "HKCU"
            | "HKEY_CURRENT_USER"
            | "HKLM"
            | "HKEY_LOCAL_MACHINE"
            | "HKU"
            | "HKEY_USERS"
            | "HKCR"
            | "HKEY_CLASSES_ROOT"
            | "HKCC"
            | "HKEY_CURRENT_CONFIG"
    ) {
        return Err(Failure::invalid(
            "registry.validate",
            "Path must be relative to HKCU, without a hive prefix",
        ));
    }
    if std::iter::once(first)
        .chain(components)
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(Failure::invalid(
            "registry.validate",
            "Path contains an empty, dot or dot-dot component",
        ));
    }
    Ok(())
}

pub fn registry_request(value: &Value) -> Probe<RegistryRequest> {
    let request: RegistryRequest = serde_json::from_value(value.clone()).map_err(|_| {
        Failure::invalid(
            "registry.validate",
            "Invalid or unknown registry probe fields",
        )
    })?;
    identifier(&request.event_id, 128, "registry.validate")?;
    if request.pid == 0 {
        return Err(Failure::invalid("registry.validate", "pid must be nonzero"));
    }
    filetime(&request.created_at)?;
    registry_path(&request.path)?;
    if request.name.encode_utf16().count() > 256 || request.name.contains('\0') {
        return Err(Failure::invalid(
            "registry.validate",
            "Value name exceeds 256 UTF-16 units or contains NUL",
        ));
    }
    if request.desired_access == 0 || request.desired_access & !ALLOWED_REGISTRY_ACCESS != 0 {
        return Err(Failure::invalid(
            "registry.validate",
            "desiredAccess allows only nonzero combinations of QUERY_VALUE, SET_VALUE, CREATE_SUB_KEY, ENUMERATE_SUB_KEYS and NOTIFY",
        ));
    }
    Ok(request)
}

pub fn echo_id(value: &Value, key: &str, max: usize) -> Value {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| Value::String(text.chars().take(max).collect()))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_only_bounded_hkcu_relative_components() {
        for bad in [
            "/Software",
            "\\Software",
            "Software/Other",
            "Software\\..\\X",
            ".",
            "..",
            "A\\.\\B",
            "A\\\\B",
            "A\\",
            "HKCU\\Software",
            "hkey_users\\SID",
            "A\0B",
        ] {
            assert!(registry_path(bad).is_err(), "accepted {bad:?}");
        }
        for good in ["", "Software", "Software\\Vendor.Name", "Software\\应用"] {
            assert!(registry_path(good).is_ok(), "rejected {good:?}");
        }
        assert!(registry_path(&"a".repeat(512)).is_ok());
        assert!(registry_path(&"a".repeat(513)).is_err());
        assert!(registry_path(&"😀".repeat(257)).is_err());
    }

    #[test]
    fn birth_match_rejects_pid_reuse_and_bad_filetimes() {
        assert!(match_birth(Some("123456"), 123456).is_ok());
        assert!(match_birth(None, 123456).is_ok());
        let mismatch = match_birth(Some("123455"), 123456).unwrap_err();
        assert_eq!(mismatch.code, 13);
        assert_eq!(mismatch.stage, "process.identity");
        for bad in [
            "",
            "0",
            "-1",
            "+1",
            "1.0",
            " 1",
            "2026-01-01",
            "18446744073709551616",
        ] {
            assert!(filetime(bad).is_err());
        }
    }

    #[test]
    fn input_is_bounded_and_unknown_probes_fail_explicitly() {
        assert!(read_bounded(&vec![b' '; INPUT_LIMIT][..]).is_ok());
        assert_eq!(
            read_bounded(&vec![b' '; INPUT_LIMIT + 1][..])
                .unwrap_err()
                .stage,
            "input.size"
        );
        for bad in [
            json!({"format":2,"processes":[],"registry":[]}),
            json!({"format":1,"processes":[],"registry":[],"shell":[]}),
            json!({"format":1,"processes":[{}, {}, {}, {}],"registry":[]}),
            json!({"format":1,"processes":[],"registry":[{}, {}, {}, {}, {}, {}, {}, {}, {}]}),
        ] {
            assert!(parse_request(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
        assert!(process_request(&json!({"role":"self","pid":1,"probe":"unknown"})).is_err());
    }

    #[test]
    fn only_explicit_specific_registry_rights_are_accepted() {
        let mut request = json!({"eventId":"e","pid":1,"createdAt":"1","path":"Software","name":"","desiredAccess":1,"allowParent":false});
        for good in [1, 2, 4, 8, 16, 31] {
            request["desiredAccess"] = json!(good);
            assert!(registry_request(&request).is_ok());
        }
        for bad in [
            0u32, 32, 0x100, 0x200, 0x20000, 0xf003f, 0x1000000, 0x10000000, 0x80000000,
        ] {
            request["desiredAccess"] = json!(bad);
            assert!(registry_request(&request).is_err());
        }
        request["desiredAccess"] = json!(1);
        request["probe"] = json!("unknown");
        assert!(registry_request(&request).is_err());
    }
}
