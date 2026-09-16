use serde_json::{json, Value};
use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_GETDESKWALLPAPER,
    SPI_SETDESKWALLPAPER,
};
pub(super) fn execute(operation: &str, input: &Value) -> Result<Value, String> {
    if operation == "wallpaper.get" {
        let mut path = vec![0u16; 32768];
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
        let end = path.iter().position(|c| *c == 0).unwrap_or(path.len());
        return Ok(json!(String::from_utf16_lossy(&path[..end])));
    }
    let path = input["path"].as_str().ok_or("缺少壁纸路径")?;
    if path.contains('\0')
        || (!path.is_empty() && (!Path::new(path).is_absolute() || !Path::new(path).is_file()))
    {
        return Err("无效壁纸路径".into());
    }
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            wide.as_ptr() as *mut c_void,
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Value::Null)
}
