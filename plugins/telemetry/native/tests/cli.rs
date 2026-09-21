use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn run(bytes: &[u8], expected_exit: i32) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_chord-observer"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(expected_exit));
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() <= 65536);
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn executable_reads_known_parent_and_preserves_registry_and_process_siblings() {
    let pid = std::process::id();
    let initial = run(
        &serde_json::to_vec(
            &json!({"format":1,"processes":[{"role":"test-parent","pid":pid}],"registry":[]}),
        )
        .unwrap(),
        0,
    );
    assert_eq!(initial["processes"][0]["ok"], true, "{initial}");
    let snapshot = &initial["processes"][0]["value"];
    let birth = snapshot["createdAt"].as_str().unwrap();
    let sid = snapshot["userSid"].as_str().unwrap();
    let missing = format!("Software\\ChordObserverMissing-{pid}-{birth}\\Child");
    let result = run(&serde_json::to_vec(&json!({"format":1,"processes":[
        {"role":"matching","pid":pid,"createdAt":birth},
        {"role":"mismatch","pid":pid,"createdAt":"1"},
        {"role":"unknown","pid":pid,"probe":"unknown"}
    ],"registry":[
        {"eventId":"existing","pid":pid,"createdAt":birth,"path":"Software","name":"","desiredAccess":1,"allowParent":false},
        {"eventId":"ancestor","pid":pid,"createdAt":birth,"path":missing,"name":"Setting","desiredAccess":2,"allowParent":true},
        {"eventId":"missing","pid":pid,"createdAt":birth,"path":missing,"name":"","desiredAccess":2,"allowParent":false}
    ]})).unwrap(), 0);
    assert_eq!(result["processes"][0]["ok"], true);
    assert_eq!(result["processes"][1]["stage"], "process.identity");
    assert_eq!(result["processes"][2]["stage"], "process.validate");
    assert_eq!(
        result["registry"][0]["value"]["checkedPath"],
        format!("HKEY_USERS\\{sid}\\Software")
    );
    assert_eq!(
        result["registry"][1]["value"]["checkedPath"],
        format!("HKEY_USERS\\{sid}\\Software"),
        "{result}"
    );
    assert_eq!(result["registry"][1]["value"]["ancestorUsed"], true);
    assert_eq!(result["registry"][1]["value"]["checkedAccess"], 4);
    assert_eq!(result["registry"][1]["value"]["requestedAccess"], 2);
    assert_eq!(result["registry"][2]["code"], 2);
    let descriptor = &result["registry"][0]["value"]["securityDescriptor"];
    assert_eq!(descriptor["ok"], true, "{result}");
    assert!(
        descriptor["value"]["ownerSid"]
            .as_str()
            .unwrap()
            .starts_with("S-1-")
    );
    let sddl = descriptor["value"]["sddl"].as_str().unwrap();
    assert!(sddl.contains("D:"));
    assert!(
        !sddl.chars().any(char::is_control),
        "SDDL contains allocation padding"
    );
    assert_eq!(result["vendorEvidence"]["schemaVersion"], 1);
    assert_eq!(
        result["vendorEvidence"]["probes"][0]["status"],
        "unavailable"
    );
    assert!(
        result["vendorEvidence"]["probes"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("observedAtMs absent")
    );

    let observed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let evidence = run(&serde_json::to_vec(&json!({"format":1,"processes":[],"registry":[
        {"eventId":"timed","pid":pid,"createdAt":birth,"path":"Software","name":"","desiredAccess":1,"allowParent":false,"observedAtMs":observed}
    ]})).unwrap(),0);
    assert_eq!(
        evidence["vendorEvidence"]["probes"][0]["status"], "ready",
        "{evidence}"
    );
    let channels = evidence["vendorEvidence"]["channels"].as_array().unwrap();
    assert!(
        channels.iter().any(|c| c["name"] == "Security"),
        "{evidence}"
    );
    assert!(channels.len() <= 8);
    assert!(
        channels
            .iter()
            .map(|c| c["events"].as_array().unwrap().len())
            .sum::<usize>()
            <= 16
    );
    for channel in channels {
        assert!(channel["scanned"].as_u64().unwrap() <= 128);
        assert_ne!(channel["code"], 15001, "Invalid Event Log XPath: {channel}");
        if channel["code"] == 5 {
            assert_ne!(channel["status"], "collected");
        }
    }
}

#[test]
fn executable_enforces_input_envelope_and_size() {
    let invalid = run(
        br#"{"format":1,"processes":[],"registry":[],"commands":[]}"#,
        2,
    );
    assert_eq!(invalid["stage"], "input.schema");
    assert_eq!(invalid["ok"], false);
    assert_eq!(run(&vec![b' '; 32769], 2)["stage"], "input.size");
}
