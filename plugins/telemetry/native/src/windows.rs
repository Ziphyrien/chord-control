use crate::protocol::{Failure, Probe, ProcessRequest, RegistryRequest, match_birth, outcome};
use serde_json::{Value, json};
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Registry::*, Threading::*},
};

// All handles are owned and closed even if a later step in the same probe fails.
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn win_error(code: u32, stage: &'static str) -> Failure {
    Failure::new(
        code,
        stage,
        std::io::Error::from_raw_os_error(code as i32).to_string(),
    )
}
fn last_error(stage: &'static str) -> Failure {
    win_error(unsafe { GetLastError() }, stage)
}
fn invalid_data(stage: &'static str, error: &'static str) -> Failure {
    Failure::new(ERROR_INVALID_DATA, stage, error)
}

struct Process {
    handle: Handle,
    pid: u32,
    created_at: u64,
}
impl Process {
    fn open(pid: u32, expected: Option<&str>) -> Probe<Self> {
        // No VM_READ, ALL_ACCESS, debug privilege, or handle reopening after the identity check.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return Err(last_error("process.open"));
        }
        let handle = Handle(raw);
        let (mut creation, mut exit, mut kernel, mut user) =
            unsafe { (zeroed(), zeroed(), zeroed(), zeroed()) };
        if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err(last_error("process.createdAt"));
        }
        let created_at = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        match_birth(expected, created_at)?;
        Ok(Self {
            handle,
            pid,
            created_at,
        })
    }

    fn token(&self, duplicate: bool) -> Probe<Handle> {
        let mut token = null_mut();
        let access = TOKEN_QUERY | if duplicate { TOKEN_DUPLICATE } else { 0 };
        if unsafe { OpenProcessToken(self.handle.0, access, &mut token) } == 0 {
            return Err(last_error("token.open"));
        }
        Ok(Handle(token))
    }

    fn executable(&self) -> Probe<String> {
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.handle.0, 0, buffer.as_mut_ptr(), &mut length) }
            == 0
        {
            return Err(last_error("process.executable"));
        }
        let path = String::from_utf16(&buffer[..length as usize]).map_err(|_| {
            invalid_data("process.executable", "Executable path is not valid UTF-16")
        })?;
        // Bound JSON expansion for three snapshots, even for pathological extended paths.
        if path.is_empty() || path.len() > 4096 {
            return Err(Failure::new(
                ERROR_BUFFER_OVERFLOW,
                "process.executable",
                "Executable path is empty or exceeds 4096 UTF-8 bytes",
            ));
        }
        Ok(path)
    }
}

// Win32 writes structs containing pointers. usize storage supplies the required alignment.
fn token_info(
    token: &Handle,
    class: TOKEN_INFORMATION_CLASS,
    stage: &'static str,
) -> Probe<Vec<usize>> {
    let mut needed = 0;
    let first = unsafe { GetTokenInformation(token.0, class, null_mut(), 0, &mut needed) };
    if first != 0 {
        return Err(invalid_data(
            stage,
            "Token information unexpectedly has no buffer",
        ));
    }
    let code = unsafe { GetLastError() };
    if code != ERROR_INSUFFICIENT_BUFFER {
        return Err(win_error(code, stage));
    }
    if needed == 0 || needed > 1024 * 1024 {
        return Err(invalid_data(stage, "Invalid token information size"));
    }
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            class,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(last_error(stage));
    }
    Ok(buffer)
}

fn token_struct<T: Copy>(buffer: &[usize], stage: &'static str) -> Probe<T> {
    if std::mem::size_of_val(buffer) < size_of::<T>() {
        return Err(invalid_data(stage, "Truncated token information"));
    }
    // T is always a Windows POD struct returned by GetTokenInformation.
    Ok(unsafe { buffer.as_ptr().cast::<T>().read() })
}

// Fixed-size token classes can return ERROR_BAD_LENGTH for a null size query.
// Supply their documented DWORD-sized output buffer directly.
fn token_dword(token: &Handle, class: TOKEN_INFORMATION_CLASS, stage: &'static str) -> Probe<u32> {
    let (mut value, mut returned) = (0u32, 0u32);
    if unsafe {
        GetTokenInformation(
            token.0,
            class,
            (&mut value as *mut u32).cast(),
            4,
            &mut returned,
        )
    } == 0
    {
        return Err(last_error(stage));
    }
    if returned != 4 {
        return Err(invalid_data(
            stage,
            "Invalid DWORD token information length",
        ));
    }
    Ok(value)
}

fn user_sid(token: &Handle) -> Probe<String> {
    let buffer = token_info(token, TokenUser, "token.userSid")?;
    let user = token_struct::<TOKEN_USER>(&buffer, "token.userSid")?;
    if unsafe { IsValidSid(user.User.Sid) } == 0 {
        return Err(invalid_data(
            "token.userSid",
            "Token returned an invalid SID",
        ));
    }
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(last_error("token.userSid"));
    }
    let _allocation = LocalAllocation(text.cast());
    // The API allocates a NUL-terminated SID string (maximum SID text is well below 256).
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| invalid_data("token.userSid", "SID text is not valid UTF-16"))
}

fn integrity(token: &Handle) -> Probe<String> {
    let buffer = token_info(token, TokenIntegrityLevel, "token.integrity")?;
    let label = token_struct::<TOKEN_MANDATORY_LABEL>(&buffer, "token.integrity")?;
    if unsafe { IsValidSid(label.Label.Sid) } == 0 {
        return Err(invalid_data("token.integrity", "Invalid integrity SID"));
    }
    let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) };
    if count == 0 {
        return Err(invalid_data("token.integrity", "Integrity SID has no RID"));
    }
    let rid = unsafe { *GetSidSubAuthority(label.Label.Sid, count as u32 - 1) };
    Ok(match rid {
        0x0000 => "untrusted".into(),
        0x1000 => "low".into(),
        0x2000 => "medium".into(),
        0x2100 => "mediumPlus".into(),
        0x3000 => "high".into(),
        0x4000 => "system".into(),
        0x5000 => "protected".into(),
        other => format!("unknown:{other}"),
    })
}

fn file_version(path: &str) -> Probe<String> {
    let path = wide(path);
    let mut ignored = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 {
        return Err(last_error("fileVersion.size"));
    }
    if size > 4 * 1024 * 1024 {
        return Err(Failure::new(
            ERROR_BUFFER_OVERFLOW,
            "fileVersion.size",
            "Version resource exceeds 4 MiB",
        ));
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return Err(last_error("fileVersion.read"));
    }
    let mut value = null_mut();
    let mut length = 0;
    if unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            wide("\\").as_ptr(),
            &mut value,
            &mut length,
        )
    } == 0
    {
        // VerQueryValue does not promise a useful GetLastError.
        return Err(Failure::new(
            ERROR_RESOURCE_DATA_NOT_FOUND,
            "fileVersion.query",
            "Fixed file version resource is missing",
        ));
    }
    if value.is_null() || length < size_of::<VS_FIXEDFILEINFO>() as u32 {
        return Err(invalid_data(
            "fileVersion.query",
            "Truncated fixed file version resource",
        ));
    }
    let info = unsafe { value.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    if info.dwSignature != 0xfeef04bd {
        return Err(invalid_data(
            "fileVersion.query",
            "Invalid fixed file version signature",
        ));
    }
    Ok(format!(
        "{}.{}.{}.{}",
        info.dwFileVersionMS >> 16,
        info.dwFileVersionMS & 0xffff,
        info.dwFileVersionLS >> 16,
        info.dwFileVersionLS & 0xffff
    ))
}

pub fn process(request: &ProcessRequest) -> Probe<Value> {
    let process = Process::open(request.pid, request.created_at.as_deref())?;
    let token = process.token(false)?;
    let elevation = token_dword(&token, TokenElevation, "token.elevated")?;
    let kind = token_dword(&token, TokenElevationType, "token.elevationType")? as i32;
    let elevation_type = if kind == TokenElevationTypeDefault {
        "default"
    } else if kind == TokenElevationTypeFull {
        "full"
    } else if kind == TokenElevationTypeLimited {
        "limited"
    } else {
        return Err(invalid_data(
            "token.elevationType",
            "Unknown token elevation type",
        ));
    };
    let integrity = integrity(&token)?;
    let sid = user_sid(&token)?;
    let executable = process.executable();
    let version = match &executable {
        Ok(path) => file_version(path),
        Err(error) => Err(Failure::new(
            error.code,
            "fileVersion.executable",
            "Executable path unavailable",
        )),
    };
    Ok(json!({
        "pid": process.pid, "createdAt": process.created_at.to_string(),
        "elevated": elevation != 0, "elevationType": elevation_type,
        "integrity": integrity, "userSid": sid,
        "executable": outcome(executable), "fileVersion": outcome(version),
    }))
}

fn open_key(root: HKEY, path: &str, access: u32) -> Probe<Key> {
    let mut handle = null_mut();
    let code = unsafe {
        RegOpenKeyExW(
            root,
            wide(path).as_ptr(),
            0,
            access | KEY_WOW64_64KEY,
            &mut handle,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(win_error(code, "registry.open"));
    }
    Ok(Key(handle))
}

pub fn uac_value(name: &str) -> Probe<u32> {
    let key = open_key(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
        KEY_QUERY_VALUE,
    )
    .map_err(|mut error| {
        error.stage = "uac.open";
        error
    })?;
    let (mut kind, mut value, mut length) = (0, 0u32, size_of::<u32>() as u32);
    let code = unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            null(),
            &mut kind,
            (&mut value as *mut u32).cast(),
            &mut length,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(win_error(code, "uac.read"));
    }
    if kind != REG_DWORD || length != 4 {
        return Err(Failure::new(
            ERROR_DATATYPE_MISMATCH,
            "uac.type",
            "UAC value must be REG_DWORD",
        ));
    }
    Ok(value)
}

fn impersonation_token(primary: &Handle) -> Probe<Handle> {
    let mut token = null_mut();
    // A token for AccessCheck only. Never impersonate the helper thread or alter privileges.
    if unsafe {
        DuplicateTokenEx(
            primary.0,
            TOKEN_QUERY,
            null(),
            SecurityImpersonation,
            TokenImpersonation,
            &mut token,
        )
    } == 0
    {
        return Err(last_error("accessCheck.duplicateToken"));
    }
    Ok(Handle(token))
}

fn security_descriptor(key: &Key) -> Probe<LocalAllocation> {
    let mut descriptor = null_mut();
    let code = unsafe {
        GetSecurityInfo(
            key.0,
            SE_REGISTRY_KEY,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if code != ERROR_SUCCESS {
        return Err(win_error(code, "registry.securityDescriptor"));
    }
    if descriptor.is_null() {
        return Err(invalid_data(
            "registry.securityDescriptor",
            "Missing security descriptor",
        ));
    }
    Ok(LocalAllocation(descriptor))
}

fn sid_text(sid: PSID) -> Probe<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(invalid_data(
            "registry.securityDescriptor",
            "Missing or invalid SID",
        ));
    }
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(last_error("registry.securityDescriptor"));
    }
    let _allocation = LocalAllocation(text.cast());
    let mut length = 0;
    while length < 256 && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err(invalid_data(
            "registry.securityDescriptor",
            "SID exceeds limit",
        ));
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| invalid_data("registry.securityDescriptor", "Invalid SID encoding"))
}

fn sddl_text(text: *const u16, capacity: u32) -> Probe<String> {
    let stage = "registry.securityDescriptor";
    if text.is_null() || capacity == 0 || capacity > 4097 {
        return Err(Failure::new(122, stage, "Invalid SDDL allocation size"));
    }
    // Windows may report an allocation longer than the string. Stop at the first
    // terminator instead of copying padding or reading uninitialized trailing units.
    let mut length = 0;
    while length < capacity as usize && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    if length == capacity as usize {
        return Err(invalid_data(stage, "Unterminated SDDL string"));
    }
    let sddl = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| invalid_data(stage, "Invalid SDDL encoding"))?;
    if sddl.len() > 4096 {
        return Err(Failure::new(122, stage, "SDDL exceeds 4096 bytes"));
    }
    Ok(sddl)
}

fn descriptor_summary(descriptor: &LocalAllocation) -> Probe<Value> {
    let stage = "registry.securityDescriptor";
    let (mut text, mut length) = (null_mut(), 0);
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.0,
            1,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut text,
            &mut length,
        )
    } == 0
    {
        return Err(last_error(stage));
    }
    let _allocation = LocalAllocation(text.cast());
    let sddl = sddl_text(text, length)?;
    let (mut owner, mut group, mut defaulted) = (null_mut(), null_mut(), 0);
    let (mut control, mut revision) = (0, 0);
    let (mut present, mut acl) = (0, null_mut());
    if unsafe { GetSecurityDescriptorOwner(descriptor.0, &mut owner, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorGroup(descriptor.0, &mut group, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
        || unsafe {
            GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted)
        } == 0
    {
        return Err(last_error(stage));
    }
    if present != 0 && !acl.is_null() && unsafe { IsValidAcl(acl) } == 0 {
        return Err(invalid_data(stage, "Invalid DACL"));
    }
    let mut aces = Vec::new();
    let count = if present != 0 && !acl.is_null() {
        unsafe { (*acl).AceCount }
    } else {
        0
    };
    for index in 0..count.min(32) {
        let mut raw = null_mut();
        if unsafe { GetAce(acl, index as u32, &mut raw) } == 0 {
            return Err(last_error(stage));
        }
        if raw.is_null() {
            return Err(invalid_data(stage, "Missing ACE"));
        }
        let header = unsafe { raw.cast::<ACE_HEADER>().read_unaligned() };
        let mut ace = json!({"type":header.AceType,"flags":header.AceFlags,
            "inherited":header.AceFlags & 0x10 != 0,"inheritOnly":header.AceFlags & 0x08 != 0});
        // Only simple allow/deny ACEs have this layout. Other types retain their raw type/flags.
        if matches!(header.AceType, 0 | 1) && header.AceSize as usize >= 16 {
            let basic = unsafe { raw.cast::<ACCESS_ALLOWED_ACE>().read_unaligned() };
            let sid_bytes = unsafe { raw.cast::<u8>().add(8) };
            let subauthorities = unsafe { *sid_bytes.add(1) } as usize;
            if 16 + subauthorities * 4 > header.AceSize as usize {
                return Err(invalid_data(stage, "Truncated ACE SID"));
            }
            let sid = sid_bytes.cast();
            ace["mask"] = json!(basic.Mask);
            ace["sid"] = json!(sid_text(sid)?);
        }
        aces.push(ace);
    }
    Ok(
        json!({"sddl":sddl,"ownerSid":sid_text(owner)?,"groupSid":sid_text(group)?,
        "daclPresent":present != 0,"daclNull":present != 0 && acl.is_null(),
        "daclProtected":control & SE_DACL_PROTECTED != 0,
        "daclAutoInherited":control & SE_DACL_AUTO_INHERITED != 0,
        "aces":aces,"acesTruncated":count > 32}),
    )
}

pub(crate) fn evidence_identity(request: &RegistryRequest) -> Probe<(String, String, u64)> {
    let process = Process::open(request.pid, Some(&request.created_at))?;
    Ok((
        user_sid(&process.token(false)?)?,
        process.executable()?,
        process.created_at,
    ))
}

fn access_check(descriptor: &LocalAllocation, token: &Handle, desired: u32) -> Probe<(bool, u32)> {
    let mapping = GENERIC_MAPPING {
        GenericRead: KEY_READ,
        GenericWrite: KEY_WRITE,
        GenericExecute: KEY_EXECUTE,
        GenericAll: KEY_ALL_ACCESS,
    };
    let mut size = size_of::<PRIVILEGE_SET>() as u32;
    // AccessCheck reports FALSE + INSUFFICIENT_BUFFER if privileges require more storage.
    for _ in 0..3 {
        if size > 1024 * 1024 {
            return Err(invalid_data("accessCheck", "Privilege set exceeds limit"));
        }
        let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
        let (mut granted, mut allowed) = (0, 0);
        let success = unsafe {
            AccessCheck(
                descriptor.0,
                token.0,
                desired,
                &mapping,
                buffer.as_mut_ptr().cast(),
                &mut size,
                &mut granted,
                &mut allowed,
            )
        };
        if success != 0 {
            return Ok((allowed != 0, granted));
        }
        let code = unsafe { GetLastError() };
        if code != ERROR_INSUFFICIENT_BUFFER {
            return Err(win_error(code, "accessCheck"));
        }
    }
    Err(Failure::new(
        ERROR_INSUFFICIENT_BUFFER,
        "accessCheck",
        "Privilege set size did not stabilize",
    ))
}

// The opener is injected in unit tests to verify missing-only fallback without registry writes.
fn nearest_key<T>(
    path: &str,
    allow_parent: bool,
    mut open: impl FnMut(&str) -> Probe<T>,
) -> Probe<(T, String, bool)> {
    let mut candidate = path;
    loop {
        match open(candidate) {
            Ok(key) => return Ok((key, candidate.into(), candidate != path)),
            Err(error)
                if allow_parent
                    && !candidate.is_empty()
                    && (error.code == ERROR_FILE_NOT_FOUND
                        || error.code == ERROR_PATH_NOT_FOUND) =>
            {
                candidate = candidate.rsplit_once('\\').map_or("", |(parent, _)| parent);
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn registry(request: &RegistryRequest) -> Probe<Value> {
    let process = Process::open(request.pid, Some(&request.created_at))?;
    let primary = process.token(true)?;
    let sid = user_sid(&primary)?;
    let token = impersonation_token(&primary)?;
    // A missing/unloaded user hive is an error; never fall back to the helper's HKCU.
    let (key, relative, ancestor) = nearest_key(&request.path, request.allow_parent, |relative| {
        let path = if relative.is_empty() {
            sid.clone()
        } else {
            format!("{sid}\\{relative}")
        };
        open_key(HKEY_USERS, &path, READ_CONTROL)
    })?;
    let descriptor = security_descriptor(&key)?;
    let checked_access = if ancestor {
        KEY_CREATE_SUB_KEY
    } else {
        request.desired_access
    };
    let (allowed, granted) = access_check(&descriptor, &token, checked_access)?;
    let checked_path = if relative.is_empty() {
        format!("HKEY_USERS\\{sid}")
    } else {
        format!("HKEY_USERS\\{sid}\\{relative}")
    };
    Ok(json!({
        "requestedAccess": request.desired_access, "checkedAccess": checked_access,
        "checkedPath": checked_path, "ancestorUsed": ancestor,
        "daclAllowed": allowed, "grantedAccess": granted,
        "securityDescriptor": outcome(descriptor_summary(&descriptor)),
        "pid": process.pid, "createdAt": process.created_at.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sddl_ends_at_terminator_before_allocation_padding() {
        let padded = [
            b'O' as u16,
            b':' as u16,
            b'S' as u16,
            b'Y' as u16,
            0,
            0,
            0xd800,
        ];
        assert_eq!(
            sddl_text(padded.as_ptr(), padded.len() as u32).unwrap(),
            "O:SY"
        );
        assert!(sddl_text(padded.as_ptr(), 4).is_err());
        assert!(sddl_text(std::ptr::null(), 0).is_err());
        let invalid = [0xd800, 0];
        assert!(sddl_text(invalid.as_ptr(), 2).is_err());
    }

    #[test]
    fn actual_process_identity_and_optional_version_failure() {
        let request = ProcessRequest {
            role: "self".into(),
            pid: std::process::id(),
            created_at: None,
        };
        let snapshot = process(&request).unwrap();
        assert_eq!(snapshot["pid"], std::process::id());
        assert!(snapshot["elevated"].is_boolean());
        assert!(snapshot["userSid"].as_str().unwrap().starts_with("S-1-"));
        assert!(snapshot["executable"]["ok"].as_bool().unwrap());
        let birth = snapshot["createdAt"].as_str().unwrap().to_string();
        assert!(
            process(&ProcessRequest {
                created_at: Some(birth.clone()),
                ..request
            })
            .is_ok()
        );
        let mismatch = ProcessRequest {
            role: "self".into(),
            pid: std::process::id(),
            created_at: Some((birth.parse::<u64>().unwrap() + 1).to_string()),
        };
        assert_eq!(process(&mismatch).unwrap_err().stage, "process.identity");
        assert!(file_version("Z:\\chord-observer-nonexistent-file.exe").is_err());
    }

    #[test]
    fn actual_token_and_synthetic_dacl_allow_and_deny() {
        let process = Process::open(std::process::id(), None).unwrap();
        let primary = process.token(true).unwrap();
        let sid = user_sid(&primary).unwrap();
        let token = impersonation_token(&primary).unwrap();
        for (acl, expected) in [
            (format!("(A;;0x2;;;{sid})"), true),
            (format!("(D;;0x2;;;{sid})(A;;0x2;;;{sid})"), false),
        ] {
            let sddl = wide(&format!("O:{sid}G:{sid}D:{acl}"));
            let mut descriptor = null_mut();
            assert_ne!(
                unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl.as_ptr(),
                        1,
                        &mut descriptor,
                        null_mut(),
                    )
                },
                0
            );
            let descriptor = LocalAllocation(descriptor);
            let summary = descriptor_summary(&descriptor).unwrap();
            assert_eq!(summary["ownerSid"], sid);
            assert_eq!(summary["groupSid"], sid);
            assert_eq!(summary["daclPresent"], true);
            assert_eq!(summary["daclNull"], false);
            assert_eq!(summary["aces"][0]["mask"], KEY_SET_VALUE);
            assert_eq!(summary["aces"][0]["type"], if expected { 0 } else { 1 });
            assert_eq!(summary["aces"][0]["inherited"], false);
            assert_eq!(summary["aces"][0]["sid"], sid);
            let (allowed, granted) = access_check(&descriptor, &token, KEY_SET_VALUE).unwrap();
            assert_eq!(allowed, expected);
            assert_eq!(granted, if expected { KEY_SET_VALUE } else { 0 });
        }
    }

    #[test]
    fn descriptor_preserves_owner_protection_and_inherit_only_flags() {
        let text = wide("O:SYG:BAD:PAI(A;CIID;0x4;;;BU)(D;CIIO;0x2;;;WD)");
        let mut raw = null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    text.as_ptr(),
                    1,
                    &mut raw,
                    null_mut(),
                )
            },
            0
        );
        let summary = descriptor_summary(&LocalAllocation(raw)).unwrap();
        assert_eq!(summary["ownerSid"], "S-1-5-18");
        assert_eq!(summary["groupSid"], "S-1-5-32-544");
        assert_eq!(summary["daclProtected"], true);
        assert_eq!(summary["daclAutoInherited"], true);
        assert_eq!(summary["aces"][0]["inherited"], true);
        assert_eq!(summary["aces"][0]["inheritOnly"], false);
        assert_eq!(summary["aces"][1]["inheritOnly"], true);
        assert_eq!(summary["aces"][1]["mask"], KEY_SET_VALUE);
    }

    #[test]
    fn fallback_is_nearest_existing_parent_and_only_for_missing_keys() {
        let mut visited = Vec::new();
        let (_, found, ancestor) = nearest_key("Software\\Missing\\Child", true, |path| {
            visited.push(path.to_string());
            if path == "Software" {
                Ok(())
            } else {
                Err(win_error(ERROR_FILE_NOT_FOUND, "registry.open"))
            }
        })
        .unwrap();
        assert_eq!(
            visited,
            ["Software\\Missing\\Child", "Software\\Missing", "Software"]
        );
        assert_eq!(found, "Software");
        assert!(ancestor);
        let denied = nearest_key::<()>("Software\\Denied", true, |_| {
            Err(win_error(ERROR_ACCESS_DENIED, "registry.open"))
        })
        .unwrap_err();
        assert_eq!(denied.code, ERROR_ACCESS_DENIED);
        let mut count = 0;
        assert!(
            nearest_key::<()>("Missing", false, |_| {
                count += 1;
                Err(win_error(ERROR_FILE_NOT_FOUND, "registry.open"))
            })
            .is_err()
        );
        assert_eq!(count, 1);
        let (_, found, ancestor) = nearest_key("Missing", true, |path| {
            if path.is_empty() {
                Ok(())
            } else {
                Err(win_error(ERROR_PATH_NOT_FOUND, "registry.open"))
            }
        })
        .unwrap();
        assert_eq!(found, "");
        assert!(ancestor);
    }

    #[test]
    fn actual_registry_descriptor_uses_target_sid_and_reports_ancestor() {
        let process = Process::open(std::process::id(), None).unwrap();
        let sid = user_sid(&process.token(false).unwrap()).unwrap();
        let mut request = RegistryRequest {
            event_id: "test".into(),
            pid: process.pid,
            created_at: process.created_at.to_string(),
            path: "Software".into(),
            name: "".into(),
            desired_access: KEY_QUERY_VALUE,
            allow_parent: false,
            observed_at_ms: None,
        };
        let result = registry(&request).unwrap();
        assert_eq!(
            result["checkedPath"],
            format!("HKEY_USERS\\{sid}\\Software")
        );
        assert_eq!(result["ancestorUsed"], false);
        request.path = format!(
            "Software\\ChordObserverMissing-{}-{}\\Child",
            process.pid, process.created_at
        );
        request.desired_access = KEY_SET_VALUE;
        assert_eq!(registry(&request).unwrap_err().code, ERROR_FILE_NOT_FOUND);
        request.allow_parent = true;
        let result = registry(&request).unwrap();
        assert_eq!(result["ancestorUsed"], true);
        assert_eq!(result["requestedAccess"], KEY_SET_VALUE);
        assert_eq!(result["checkedAccess"], KEY_CREATE_SUB_KEY);
        assert_eq!(
            result["checkedPath"],
            format!("HKEY_USERS\\{sid}\\Software")
        );
        request.created_at = (process.created_at + 1).to_string();
        assert_eq!(registry(&request).unwrap_err().stage, "process.identity");
    }
}
