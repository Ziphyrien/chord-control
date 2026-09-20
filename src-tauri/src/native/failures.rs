//! Bounded execution facts, independent of diagnostics consumers and plugin policy.
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) struct Failure {
    pub message: String,
    pub api: Option<&'static str>,
    pub code: Option<i32>,
    pub target: Value,
    pub desired_access: Option<u32>,
}
impl Failure {
    pub fn io(
        api: &'static str,
        error: std::io::Error,
        target: Value,
        desired_access: Option<u32>,
    ) -> Self {
        Self {
            message: error.to_string(),
            api: Some(api),
            code: error.raw_os_error(),
            target,
            desired_access,
        }
    }
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            message,
            api: None,
            code: None,
            target: Value::Null,
            desired_access: None,
        }
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

pub(super) struct History {
    since_ms: u64,
    sequence: u64,
    events: VecDeque<Value>,
}
impl Default for History {
    fn default() -> Self {
        Self {
            since_ms: now_ms(),
            sequence: 0,
            events: VecDeque::new(),
        }
    }
}
impl History {
    const LIMIT: usize = 16;
    pub fn record(
        &mut self,
        request_id: &str,
        plugin_id: &str,
        operation: &str,
        process: Value,
        failure: &Failure,
    ) {
        self.sequence += 1;
        if self.events.len() == Self::LIMIT {
            self.events.pop_front();
        }
        self.events.push_back(json!({
            "eventId": request_id.chars().take(100).collect::<String>(), "sequence": self.sequence, "observedAtMs": now_ms(),
            "pluginId": plugin_id.chars().take(150).collect::<String>(),
            "operation": operation.chars().take(100).collect::<String>(), "process": process,
            "api": failure.api, "code": failure.code, "target": failure.target,
            "desiredAccess": failure.desired_access,
            "message": failure.message.chars().take(600).collect::<String>(),
        }));
    }
    pub fn snapshot(&self) -> Value {
        json!({"sinceMs": self.since_ms, "total": self.sequence, "retained": self.events.len(),
            "dropped": self.sequence.saturating_sub(self.events.len() as u64), "events": self.events})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_bounded_attributed_facts_without_request_values() {
        let mut history = History::default();
        let failure = Failure::io(
            "RegSetValueExW",
            std::io::Error::from_raw_os_error(5),
            json!({"kind":"registry", "hive":"HKCU", "path":"Software\\Test", "name":"Value"}),
            Some(2),
        );
        for n in 0..20 {
            history.record(
                &format!("request-{n}"),
                "example.plugin",
                "registry.write",
                json!({"pid":42,"createdAt":"123"}),
                &failure,
            );
        }
        let snapshot = history.snapshot();
        assert_eq!(snapshot["dropped"], 4);
        assert_eq!(snapshot["retained"], 16);
        let event = &snapshot["events"][0];
        assert_eq!(event["eventId"], "request-4");
        assert_eq!(event["pluginId"], "example.plugin");
        assert_eq!(event["api"], "RegSetValueExW");
        assert_eq!(event["code"], 5);
        assert_eq!(event["process"]["createdAt"], "123");
        assert!(event.get("input").is_none());
        assert!(event["target"].get("value").is_none());
    }
}
