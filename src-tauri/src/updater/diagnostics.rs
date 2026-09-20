//! Update evidence survives the desktop process. It never controls update behavior.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

/// Same current-user data root as desktop::data_dir; also available before Tauri starts.
pub(crate) fn record(event: &str, attempt: Option<&str>, detail: Value) {
    let Some(root) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let directory = PathBuf::from(root).join("ChordControl").join("updates");
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let entry = json!({
        "format": 1,
        "time_ms": timestamp(),
        "pid": std::process::id(),
        "host_version": env!("CARGO_PKG_VERSION"),
        "attempt": attempt,
        "event": event,
        "detail": detail,
    });
    if let Ok(bytes) = serde_json::to_vec(&entry) {
        crate::logging::append(&directory.join("host.log"), &bytes);
    }
}

#[derive(Clone)]
pub(super) struct Attempt {
    id: String,
}
impl Attempt {
    pub(super) fn new(install: bool, automatic: bool) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let trace = Self {
            id: format!(
                "{}-{}-{}",
                timestamp(),
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        };
        trace.event(
            "check_started",
            json!({"install": install, "automatic": automatic}),
        );
        trace
    }
    pub(super) fn event(&self, event: &str, detail: Value) {
        record(event, Some(&self.id), detail);
    }
}
