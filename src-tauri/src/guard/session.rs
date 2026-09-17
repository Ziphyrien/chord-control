//! Cross-process session store. Every token transition and identity publication uses the gate.
use crate::native::process::{identity, open, Handle};
use serde::{Deserialize, Serialize};
use std::os::windows::ffi::OsStrExt;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
    System::Threading::{
        CreateMutexW, ReleaseMutex, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    },
};

pub(super) struct Gate(Handle);
impl Gate {
    pub fn acquire(dir: &Path, purpose: &str, timeout: u32) -> Result<Self, String> {
        // Stable across compiler/library versions; the directory contains the user profile.
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in dir
            .to_string_lossy()
            .to_lowercase()
            .bytes()
            .chain(purpose.bytes())
        {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
        }
        let name: Vec<u16> = format!("Local\\ChordControl-{hash:016x}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let handle = Handle(handle);
        match unsafe { WaitForSingleObject(handle.0, timeout) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            WAIT_TIMEOUT => Err("Guard session is busy".into()),
            _ => Err(std::io::Error::last_os_error().to_string()),
        }
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}

#[derive(Clone)]
pub(super) struct Run {
    pub dir: PathBuf,
    pub token: String,
}
#[derive(Serialize, Deserialize)]
struct Identity {
    pid: u32,
    executable: String,
    created: String,
    token: String,
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 {
        return Err("Oversized guard record".into());
    }
    Ok(bytes)
}
fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
impl Run {
    pub fn active(&self) -> bool {
        !self.token.is_empty()
            && read(&self.dir.join("run")).is_ok_and(|v| v == self.token.as_bytes())
    }
    pub fn current(dir: PathBuf) -> Self {
        let token = read(&dir.join("run"))
            .ok()
            .and_then(|v| String::from_utf8(v).ok())
            .unwrap_or_default();
        Self { dir, token }
    }
    /// Caller holds the directory gate. A resumer can only adopt, never mint a token.
    pub fn begin(dir: PathBuf, resume: Option<&str>) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let token = match resume {
            Some(token) => token.to_owned(),
            None => format!(
                "{:?}",
                unsafe { windows::Win32::System::Com::CoCreateGuid() }.map_err(|e| e.to_string())?
            ),
        };
        let run = Self { dir, token };
        if resume.is_some() {
            if !run.active() {
                return Err("Guard resume token was revoked".into());
            }
        } else {
            publish(&run.dir.join("run"), run.token.as_bytes())?;
        }
        run.record("desktop")?;
        Ok(run)
    }
    /// Caller holds the gate, preventing an old revoker from deleting a new session.
    pub fn revoke(&self) -> Result<(), String> {
        if !self.active() {
            return Ok(());
        }
        fs::remove_file(self.dir.join("run")).map_err(|e| e.to_string())
    }
    pub fn record(&self, role: &str) -> Result<(), String> {
        if !self.active() {
            return Err("Guard session no longer active".into());
        }
        let pid = std::process::id();
        let (executable, created) = identity(&open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?)?;
        let value = Identity {
            pid,
            executable,
            created,
            token: self.token.clone(),
        };
        publish(
            &self.dir.join(format!("{role}.json")),
            &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
        )
    }
    pub fn alive(&self, role: &str) -> bool {
        let Ok(bytes) = read(&self.dir.join(format!("{role}.json"))) else {
            return false;
        };
        let Ok(saved) = serde_json::from_slice::<Identity>(&bytes) else {
            return false;
        };
        if !self.token.is_empty() && saved.token != self.token {
            return false;
        }
        let Ok(handle) = open(
            saved.pid,
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
        ) else {
            return false;
        };
        let Ok((executable, created)) = identity(&handle) else {
            return false;
        };
        let Ok(own) = std::env::current_exe() else {
            return false;
        };
        executable.eq_ignore_ascii_case(&saved.executable)
            && executable.eq_ignore_ascii_case(&own.to_string_lossy())
            && created == saved.created
            && unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_TIMEOUT
    }
    pub fn log(&self, message: &str) {
        crate::logging::append(&self.dir.join("guard.log"), message.as_bytes());
    }
}
