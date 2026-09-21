//! Role parsing has no OS side effects; maintenance is distinct from resumable sessions.
use std::{ffi::OsString, path::PathBuf};
pub(super) struct Options {
    pub dir: PathBuf,
    pub watchdog: Option<String>,
    pub resume: Option<String>,
    pub maintenance: bool,
    pub uninstall: bool,
}
impl Options {
    pub fn read() -> Result<Self, String> {
        let args: Vec<OsString> = std::env::args_os().skip(1).collect();
        let dir = std::env::var_os("CHORD_CONTROL_GUARD_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("LOCALAPPDATA")
                    .map(|v| PathBuf::from(v).join("ChordControl/guard"))
            })
            .ok_or("LOCALAPPDATA unavailable")?;
        let mut options = Self::parse(&args, dir)?;
        if options.dir.exists() {
            options.dir = std::fs::canonicalize(options.dir).map_err(|e| e.to_string())?;
        }
        Ok(options)
    }
    fn parse(args: &[OsString], mut dir: PathBuf) -> Result<Self, String> {
        let mut watchdog = None;
        let mut resume = None;
        let mut maintenance = false;
        let mut uninstall = false;
        let mut directory_seen = false;
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            if arg == "--maintenance-stop" || arg == "--uninstall-cleanup" {
                if maintenance {
                    return Err("Duplicate maintenance mode".into());
                }
                maintenance = true;
                uninstall = arg == "--uninstall-cleanup";
            } else if arg == "--guard-directory" {
                if directory_seen {
                    return Err("Duplicate guard directory".into());
                }
                directory_seen = true;
                index += 1;
                dir = PathBuf::from(args.get(index).ok_or("Missing guard directory")?);
            } else if arg == "--watchdog" || arg == "--guard-resume" {
                index += 1;
                let token = args
                    .get(index)
                    .and_then(|v| v.to_str())
                    .ok_or("Missing guard token")?;
                if token.is_empty() || token.len() > 128 || token.starts_with("--") {
                    return Err("Invalid guard token".into());
                }
                let slot = if arg == "--watchdog" {
                    &mut watchdog
                } else {
                    &mut resume
                };
                if slot.replace(token.to_owned()).is_some() {
                    return Err("Duplicate guard mode".into());
                }
            }
            index += 1;
        }
        if usize::from(maintenance)
            + usize::from(watchdog.is_some())
            + usize::from(resume.is_some())
            > 1
        {
            return Err("Conflicting guard modes".into());
        }
        if !dir.is_absolute() {
            return Err("Guard directory must be absolute".into());
        }
        Ok(Self {
            dir,
            watchdog,
            resume,
            maintenance,
            uninstall,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: &[&str]) -> Result<Options, String> {
        Options::parse(
            &args
                .iter()
                .map(|value| OsString::from(*value))
                .collect::<Vec<_>>(),
            PathBuf::from(r"C:\unused-test-directory"),
        )
    }
    #[test]
    fn maintenance_never_becomes_a_resume_or_fresh_role() {
        let update = parse(&["--maintenance-stop"]).unwrap();
        assert!(
            update.maintenance
                && !update.uninstall
                && update.resume.is_none()
                && update.watchdog.is_none()
        );
        let uninstall = parse(&["--uninstall-cleanup"]).unwrap();
        assert!(uninstall.maintenance && uninstall.uninstall);
        assert!(parse(&["--maintenance-stop", "--guard-resume", "token"]).is_err());
        assert!(parse(&["--uninstall-cleanup", "--watchdog", "token"]).is_err());
        assert!(parse(&["--maintenance-stop", "--uninstall-cleanup"]).is_err());
    }
    #[test]
    fn resume_token_survives_bootstrap_arguments_and_invalid_roles_fail() {
        let options = parse(&[
            "--background",
            "--guard-resume",
            "original-token",
            "--startup-owner",
            "S-1-5-21-1-1001",
            "--elevation-attempt",
            "123",
        ])
        .unwrap();
        assert_eq!(options.resume.as_deref(), Some("original-token"));
        assert!(!options.maintenance && options.watchdog.is_none());
        for args in [
            vec!["--guard-resume"],
            vec!["--watchdog", ""],
            vec!["--watchdog", "a", "--guard-resume", "b"],
            vec!["--guard-resume", "a", "--guard-resume", "b"],
            vec!["--guard-directory", "relative"],
        ] {
            assert!(parse(&args).is_err());
        }
    }
}
