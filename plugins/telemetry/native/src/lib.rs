#![doc = include_str!("contract.md")]

#[cfg(not(all(target_os = "windows", target_arch = "x86_64", target_env = "msvc")))]
compile_error!("chord-observer supports x86_64-pc-windows-msvc only");

#[cfg(all(not(debug_assertions), not(target_feature = "crt-static")))]
compile_error!(
    "Release builds require RUSTFLAGS='-C target-feature=+crt-static' (or equivalent CARGO_ENCODED_RUSTFLAGS) to ship without a VC runtime installation"
);

mod evidence;
pub mod protocol;
mod windows;

use protocol::{Failure, echo_id, outcome, parse_request, process_request, registry_request};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

fn observed_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn failure_response(failure: Failure) -> Value {
    let mut value = outcome::<()>(Err(failure));
    value["format"] = json!(1);
    value["observedAtMs"] = json!(observed_at_ms());
    value
}

pub fn observe(bytes: &[u8]) -> Value {
    let request = match parse_request(bytes) {
        Ok(request) => request,
        Err(error) => return failure_response(error),
    };
    let observed_at = observed_at_ms();
    let mut uac = serde_json::Map::new();
    for name in [
        "EnableLUA",
        "FilterAdministratorToken",
        "ConsentPromptBehaviorAdmin",
        "PromptOnSecureDesktop",
    ] {
        uac.insert(name.into(), outcome(windows::uac_value(name)));
    }
    let processes: Vec<_> = request
        .processes
        .iter()
        .map(|raw| {
            let mut result =
                outcome(process_request(raw).and_then(|request| windows::process(&request)));
            result["role"] = echo_id(raw, "role", 64);
            result["pid"] = raw
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|pid| *pid <= u32::MAX as u64)
                .map_or(Value::Null, |pid| json!(pid));
            result
        })
        .collect();
    let registry: Vec<_> = request
        .registry
        .iter()
        .map(|raw| {
            let mut result =
                outcome(registry_request(raw).and_then(|request| windows::registry(&request)));
            result["eventId"] = echo_id(raw, "eventId", 128);
            result
        })
        .collect();
    let vendor_evidence = evidence::collect(&request.registry, &registry, observed_at);
    json!({
        "format": 1, "observedAtMs": observed_at, "uac": uac,
        "processes": processes, "registry": registry,
        "vendorEvidence": vendor_evidence,
    })
}

/// Includes the trailing newline in the 64 KiB limit. All normal fields are bounded before here.
pub fn encode_response(response: &Value) -> Vec<u8> {
    let mut response = response.clone();
    let mut bytes = serde_json::to_vec(&response).expect("JSON Value serialization is infallible");
    // Prefer the current AccessCheck results over optional historical records and large SDDL.
    // Never truncate JSON or silently drop a successful sibling probe.
    if bytes.len() >= protocol::OUTPUT_LIMIT {
        if let Some(channels) = response["vendorEvidence"]["channels"].as_array_mut() {
            for channel in channels {
                if channel["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
                {
                    channel["events"] = json!([]);
                    channel["status"] = json!("partial");
                    channel["code"] = json!(122);
                    channel["reason"] = json!("Event details omitted to fit response byte limit");
                }
            }
        }
        if response.get("vendorEvidence").is_some() {
            response["vendorEvidence"]["status"] = json!("partial");
            response["vendorEvidence"]["reason"] =
                json!("Optional evidence trimmed to fit response byte limit");
        }
        bytes = serde_json::to_vec(&response).expect("JSON Value serialization is infallible");
    }
    if bytes.len() >= protocol::OUTPUT_LIMIT {
        if let Some(registry) = response["registry"].as_array_mut() {
            for probe in registry {
                if probe["value"].get("securityDescriptor").is_some() {
                    probe["value"]["securityDescriptor"] = outcome::<()>(Err(Failure::new(
                        122,
                        "registry.securityDescriptor",
                        "Descriptor details omitted to fit response byte limit",
                    )));
                }
            }
        }
        bytes = serde_json::to_vec(&response).expect("JSON Value serialization is infallible");
    }
    if bytes.len() >= protocol::OUTPUT_LIMIT {
        bytes = serde_json::to_vec(&failure_response(Failure::new(
            122,
            "output.size",
            "Output exceeds 65536 bytes",
        )))
        .expect("JSON Value serialization is infallible");
    }
    bytes.push(b'\n');
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_unknown_probes_preserve_successful_siblings() {
        let request = json!({"format":1,"processes":[
            {"role":"unknown","pid":std::process::id(),"probe":"unknown"},
            {"role":"self","pid":std::process::id()},
            {"role":"mismatch","pid":std::process::id(),"createdAt":"1"}
        ],"registry":[
            {"eventId":"unknown","pid":std::process::id(),"createdAt":"1","path":"Software","name":"","desiredAccess":1,"allowParent":false,"probe":"unknown"}
        ]});
        let result = observe(&serde_json::to_vec(&request).unwrap());
        assert_eq!(result["processes"][0]["ok"], false);
        assert_eq!(result["processes"][0]["stage"], "process.validate");
        assert_eq!(result["processes"][1]["ok"], true);
        assert_eq!(result["processes"][2]["stage"], "process.identity");
        assert_eq!(result["registry"][0]["stage"], "registry.validate");
        assert_eq!(result["uac"].as_object().unwrap().len(), 4);
        assert_eq!(result["vendorEvidence"]["status"], "unavailable");
        assert!(encode_response(&result).len() <= protocol::OUTPUT_LIMIT);
    }

    #[test]
    fn optional_evidence_size_limit_keeps_accesscheck_siblings() {
        let response = json!({"format":1,"registry":[{"eventId":"e","ok":true,"value":{"daclAllowed":false,"checkedAccess":4}}],
            "vendorEvidence":{"schemaVersion":1,"status":"collected","channels":[{"name":"Security","events":[{"oldSd":"a".repeat(protocol::OUTPUT_LIMIT)}]}]}});
        let bytes = encode_response(&response);
        assert!(bytes.len() <= protocol::OUTPUT_LIMIT);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["registry"][0]["value"]["daclAllowed"], false);
        assert_eq!(value["vendorEvidence"]["status"], "partial");
        assert_eq!(value["vendorEvidence"]["channels"][0]["code"], 122);
    }

    #[test]
    fn malformed_envelope_and_oversized_output_are_explicit_errors() {
        let result = observe(br#"{"format":1,"processes":[],"registry":[],"commands":[]}"#);
        assert_eq!(result["ok"], false);
        assert_eq!(result["stage"], "input.schema");
        assert!(result["code"].is_u64());
        assert!(result.get("errorCode").is_none());
        let bytes = encode_response(&json!({"large":"x".repeat(protocol::OUTPUT_LIMIT)}));
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["stage"], "output.size");
        assert!(bytes.len() <= protocol::OUTPUT_LIMIT);
    }
}
