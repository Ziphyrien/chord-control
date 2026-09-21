//! Release startup keeps the interactive user's SID while requesting normal UAC elevation.
use crate::native::process::Handle;
use serde::Serialize;
use serde_json::json;
use std::{
    ffi::OsString,
    mem::size_of,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, HANDLE},
    Security::{
        Authorization::ConvertSidToStringSidW, GetSidSubAuthority, GetSidSubAuthorityCount,
        GetTokenInformation, TokenElevation, TokenElevationType, TokenIntegrityLevel,
        TokenSessionId, TokenUser, TOKEN_ELEVATION, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL,
        TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Token {
    pub sid: String,
    pub elevated: bool,
    pub elevation_type: u32,
    pub integrity_rid: u32,
    pub session_id: u32,
}
impl Token {
    pub fn high(&self) -> bool {
        self.elevated
            && self.integrity_rid >= 0x3000
            && self.integrity_rid < 0x4000
            && self.session_id != 0
    }
}
fn information(token: &Handle, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>, String> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token.0, class, std::ptr::null_mut(), 0, &mut length);
    }
    if length == 0 || length > 64 * 1024 {
        return Err("Invalid token information size".into());
    }
    // Pointer-sized storage keeps TOKEN_USER and TOKEN_MANDATORY_LABEL aligned.
    let mut data = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            class,
            data.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(data)
}
pub(crate) fn inspect(process: HANDLE) -> Result<Token, String> {
    let mut raw = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let token = Handle(raw);
    let user = information(&token, TokenUser)?;
    let user = unsafe { &*user.as_ptr().cast::<TOKEN_USER>() };
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let sid = unsafe {
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        sid
    };
    let integrity = information(&token, TokenIntegrityLevel)?;
    let label = unsafe { &*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
    let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) };
    if count == 0 {
        return Err("Invalid token integrity SID".into());
    }
    let integrity_rid = unsafe { *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)) };
    let elevation = information(&token, TokenElevation)?;
    let elevated = unsafe { (*elevation.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated != 0 };
    let kind = information(&token, TokenElevationType)?;
    let session = information(&token, TokenSessionId)?;
    Ok(Token {
        sid,
        elevated,
        integrity_rid,
        elevation_type: unsafe { *kind.as_ptr().cast::<u32>() },
        session_id: unsafe { *session.as_ptr().cast::<u32>() },
    })
}
pub(crate) fn current() -> Result<Token, String> {
    inspect(unsafe { GetCurrentProcess() })
}

fn argument(args: &[OsString], name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    for (index, value) in args.iter().enumerate() {
        if value == name {
            let value = args
                .get(index + 1)
                .and_then(|v| v.to_str())
                .filter(|v| !v.is_empty() && !v.starts_with("--"))
                .ok_or_else(|| format!("Missing {name}"))?;
            if found.replace(value.to_owned()).is_some() {
                return Err(format!("Duplicate {name}"));
            }
        }
    }
    Ok(found)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn validate(token: &Token, args: &[OsString], time: u64) -> Result<bool, String> {
    if let Some(owner) = argument(args, "--startup-owner")? {
        if owner != token.sid {
            return Err("提权账户与原用户不同，已停止启动；请使用原用户的管理员令牌".into());
        }
    }
    let attempt = argument(args, "--elevation-attempt")?;
    if let Some(attempt) = &attempt {
        let requested = attempt
            .parse::<u64>()
            .map_err(|_| "Invalid elevation attempt")?;
        if requested > time || time - requested > 180 {
            return Err("Elevation request expired".into());
        }
        if argument(args, "--startup-owner")?.is_none() {
            return Err("Elevation owner missing".into());
        }
    }
    if token.session_id == 0 {
        return Err("Chord Control requires an interactive user session".into());
    }
    Ok(attempt.is_some())
}
/// Called before logging, profile access, CLI side effects, and single-instance handling.
pub(crate) fn validate_identity() -> Result<(), String> {
    validate(
        &current()?,
        &std::env::args_os().skip(1).collect::<Vec<_>>(),
        now(),
    )
    .map(|_| ())
}
/// True means a replacement was launched; the ordinary process must exit without a session.
pub(crate) fn bootstrap() -> Result<bool, String> {
    let token = current()?;
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    let attempted = validate(&token, &args, now())?;
    crate::updater::diagnostics::record(
        "startup_token",
        None,
        json!({"token": token, "debug": cfg!(debug_assertions)}),
    );
    if cfg!(debug_assertions) || token.high() {
        return Ok(false);
    }
    if attempted {
        return Err("管理员令牌不可用，已停止重复提权；请检查当前账户权限".into());
    }
    if argument(&args, "--startup-owner")?.is_none() {
        args.extend(["--startup-owner".into(), token.sid.clone().into()]);
    }
    args.extend(["--elevation-attempt".into(), now().to_string().into()]);
    crate::updater::diagnostics::record(
        "elevation_requested",
        None,
        json!({"ownerSid":token.sid,"token":token}),
    );
    let result = crate::shell_launch::runas(args, Duration::from_secs(120));
    crate::updater::diagnostics::record(
        "elevation_outcome",
        None,
        json!({"ok":result.is_ok(),"error":result.as_ref().err()}),
    );
    result.map(|()| true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn token() -> Token {
        Token {
            sid: "S-1-5-21-1-2-3-1001".into(),
            elevated: true,
            elevation_type: 2,
            integrity_rid: 0x3000,
            session_id: 1,
        }
    }
    #[test]
    fn identity_and_retry_policy() {
        let token = token();
        assert!(token.high());
        let args = [
            "--startup-owner".into(),
            token.sid.clone().into(),
            "--elevation-attempt".into(),
            "100".into(),
        ];
        assert_eq!(validate(&token, &args, 150).unwrap(), true);
        assert!(validate(&token, &args, 281).is_err());
        let mut wrong = Token {
            sid: token.sid.clone(),
            elevated: token.elevated,
            elevation_type: token.elevation_type,
            integrity_rid: token.integrity_rid,
            session_id: token.session_id,
        };
        wrong.sid = "S-1-5-21-1-2-3-500".into();
        assert!(validate(&wrong, &args, 150).is_err());
        wrong.elevated = false;
        assert!(!wrong.high());
        wrong.elevated = true;
        wrong.integrity_rid = 0x2000;
        assert!(!wrong.high());
        wrong.integrity_rid = 0x4000;
        wrong.session_id = 0;
        assert!(!wrong.high());
    }
    #[test]
    fn inspect_current_token_read_only() {
        let observed = current().expect("read-only process token inspection");
        assert!(observed.sid.starts_with("S-1-"));
        assert!((1..=3).contains(&observed.elevation_type));
        // CI may be elevated or limited; inspecting never requests elevation or creates a task.
        assert!(observed.integrity_rid > 0);
    }
}
