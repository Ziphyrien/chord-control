//! Generic wallpaper get/set. Selection, locking and restoration remain plugin-owned.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    ffi::{c_void, OsStr},
    os::windows::ffi::OsStrExt,
    path::Path,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendNotifyMessageW, SystemParametersInfoW, HWND_BROADCAST, SPIF_UPDATEINIFILE,
    SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, WM_SETTINGCHANGE,
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Set {
    path: String,
}
fn get() -> Result<Value, String> {
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
        return Err(std::io::Error::last_os_error().to_string());
    }
    let end = path
        .iter()
        .position(|ch| *ch == 0)
        .ok_or("Unterminated wallpaper path")?;
    Ok(json!(String::from_utf16_lossy(&path[..end])))
}
fn set(input: Set) -> Result<Value, String> {
    if input.path.contains('\0')
        || input.path.encode_utf16().count() >= 32768
        || (!input.path.is_empty()
            && (!Path::new(&input.path).is_absolute() || !Path::new(&input.path).is_file()))
    {
        return Err("无效壁纸路径".into());
    }
    let mut path: Vec<u16> = OsStr::new(&input.path)
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
        return Err(std::io::Error::last_os_error().to_string());
    }
    // Notify other windows asynchronously; a hung third-party window must not hold up
    // plugin disposal. No pointer crosses the asynchronous message boundary.
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
pub(super) fn execute(operation: &str, input: &Value) -> Result<Value, String> {
    match operation {
        "wallpaper.get" => get(),
        "wallpaper.set" => set(serde_json::from_value(input.clone()).map_err(|e| e.to_string())?),
        _ => Err("未知壁纸操作".into()),
    }
}
