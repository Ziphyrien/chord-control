//! Deterministic task identity, XML encoding, and migration choice; no machine state.
use std::path::Path;

pub(super) fn owner(sid: &str) -> Result<(), String> {
    if !sid.starts_with("S-1-")
        || sid.len() > 184
        || !sid[2..].bytes().all(|v| v.is_ascii_digit() || v == b'-')
    {
        return Err("Invalid startup owner SID".into());
    }
    Ok(())
}
pub(super) fn normalized(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_lowercase()
}
pub(super) fn task_name(sid: &str, directory: &Path) -> Result<String, String> {
    owner(sid)?;
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in normalized(directory).bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    Ok(format!("ChordControl-{sid}-{hash:016x}"))
}
pub(super) fn arguments(sid: &str) -> Result<String, String> {
    owner(sid)?;
    Ok(format!("--background --startup-owner {sid}"))
}
fn xml_text(value: &str) -> Result<String, String> {
    if value
        .chars()
        .any(|ch| ch < ' ' && !matches!(ch, '\t' | '\n' | '\r'))
    {
        return Err("Invalid task XML text".into());
    }
    Ok(value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;"))
}
pub(super) fn xml(sid: &str, executable: &Path) -> Result<String, String> {
    let arguments = xml_text(&arguments(sid)?)?;
    let directory = executable.parent().ok_or("Executable directory missing")?;
    let path = xml_text(
        executable
            .to_str()
            .ok_or("Executable path is not Unicode")?,
    )?;
    let directory = xml_text(
        directory
            .to_str()
            .ok_or("Executable directory is not Unicode")?,
    )?;
    let sid = xml_text(sid)?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Chord Control current-user login</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Owner"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Owner"><Exec><Command>{path}</Command><Arguments>{arguments}</Arguments><WorkingDirectory>{directory}</WorkingDirectory></Exec></Actions>
</Task>"#
    ))
}
pub(super) fn desired(task: Option<bool>, legacy: bool, initialized: bool) -> bool {
    task.unwrap_or(legacy || !initialized)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_preserves_both_choices_and_task_wins() {
        assert!(desired(None, false, false));
        assert!(desired(None, true, true));
        assert!(!desired(None, false, true));
        assert!(!desired(Some(false), true, false));
        assert!(desired(Some(true), false, true));
    }
    #[test]
    fn identity_stable_per_owner_and_directory() {
        let first = task_name("S-1-5-21-1-1001", Path::new(r"C:\Apps\Chord")).unwrap();
        assert_eq!(
            first,
            task_name("S-1-5-21-1-1001", Path::new(r"c:\apps\chord")).unwrap()
        );
        assert_ne!(
            first,
            task_name("S-1-5-21-1-1002", Path::new(r"C:\Apps\Chord")).unwrap()
        );
        assert_ne!(
            first,
            task_name("S-1-5-21-1-1001", Path::new(r"D:\Apps\Chord")).unwrap()
        );
        assert!(task_name("S-1-5-21\"/><Exec>", Path::new(r"C:\Apps")).is_err());
    }
    #[test]
    fn task_xml_has_exact_interactive_owner_and_escaped_action() {
        let sid = "S-1-5-21-1-2-3-1001";
        let xml = xml(sid, Path::new(r"C:\A&B\路径 空格\host.exe")).unwrap();
        assert_eq!(xml.matches(&format!("<UserId>{sid}</UserId>")).count(), 2);
        assert!(xml.contains(
            "<LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel>"
        ));
        assert!(xml.contains(r"<Command>C:\A&amp;B\路径 空格\host.exe</Command>"));
        assert!(xml.contains(&format!(
            "<Arguments>--background --startup-owner {sid}</Arguments>"
        )));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(!xml.contains("Password") && !xml.contains("S-1-5-18"));
        assert_eq!(xml_text("a<&>\"'").unwrap(), "a&lt;&amp;&gt;&quot;&apos;");
        assert!(xml_text("bad\0path").is_err());
    }
}
