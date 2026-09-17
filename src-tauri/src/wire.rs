//! Desktop-side transport validation. Application semantics belong to the controller/plugins.
use serde_json::Value;
pub(crate) fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
}
pub(crate) fn validate_public_command(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("Command must be an object")?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("Command type missing")?;
    if !matches!(
        kind,
        "snapshot"
            | "check_updates"
            | "set_settings"
            | "add_plugin"
            | "install"
            | "set_enabled"
            | "remove_plugin"
            | "plugin_ui"
            | "plugin_call"
    ) {
        return Err("Unknown or reserved desktop command".into());
    }
    if !value["id"]
        .as_str()
        .is_some_and(|id| !id.is_empty() && id.len() <= 128)
    {
        return Err("Command correlation ID missing or invalid".into());
    }
    if matches!(kind, "set_enabled" | "remove_plugin") {
        if let Some(affected) = object.get("affectedPluginIds") {
            let ids = affected
                .as_array()
                .ok_or("affectedPluginIds must be an array")?;
            if ids.len() > 1024
                || ids
                    .iter()
                    .any(|id| !id.as_str().is_some_and(valid_plugin_id))
            {
                return Err("Invalid affectedPluginIds".into());
            }
        }
    }
    Ok(())
}
