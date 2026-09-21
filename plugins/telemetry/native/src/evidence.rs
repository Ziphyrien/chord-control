//! Read-only, bounded event evidence. No event messages, registry values, or command lines leave here.
use crate::protocol::{Failure, Probe, outcome, registry_request};
use roxmltree::{Document, Node, ParsingOptions};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    ptr::null_mut,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use windows_sys::{
    Win32::{Foundation::*, Security::Authentication::Identity::*, System::EventLog::*},
    core::GUID,
};

const WINDOW: u64 = 120_000;
const MAX_AGE: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS: usize = 16;
const XML_LIMIT: usize = 128 * 1024;
const EVIDENCE_LIMIT: usize = 24 * 1024;
const NS: &str = "http://schemas.microsoft.com/win/2004/08/events/event";
const SECURITY: &str = "Microsoft-Windows-Security-Auditing";
const SYSMON: &str = "Microsoft-Windows-Sysmon";

struct EventHandle(EVT_HANDLE);
impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            EvtClose(self.0);
        }
    }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn error(stage: &'static str) -> Failure {
    Failure::new(
        unsafe { GetLastError() },
        stage,
        "Windows event/audit API failed",
    )
}
fn invalid(reason: &str) -> Failure {
    Failure::new(13, "events.xml", reason)
}

#[derive(Clone, Debug)]
struct Target {
    id: String,
    pid: u32,
    birth_ms: u64,
    verified_until_ms: u64,
    observed: u64,
    sid: String,
    image: String,
    path: String,
    name: String,
    ancestor: Option<String>,
}
fn normalized(s: &str) -> String {
    let s = s.to_lowercase();
    for prefix in ["\\registry\\user\\", "hkey_users\\", "hku\\"] {
        if let Some(tail) = s.strip_prefix(prefix) {
            return format!("hku\\{tail}");
        }
    }
    s
}
fn field<'a, 'input>(parent: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    parent.children().find(|n| {
        n.is_element() && n.tag_name().name() == name && n.tag_name().namespace() == Some(NS)
    })
}
fn bounded(s: &str, max: usize) -> Option<String> {
    (s.len() <= max && !s.chars().any(|c| c.is_control())).then(|| s.to_string())
}
fn numeric(s: &str) -> Option<u64> {
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        s.parse().ok()
    }
}
// EvtRender emits UTC ISO8601. Reject non-UTC, invalid dates and leap seconds rather than guessing.
fn timestamp(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    if s.len() < 19
        || !s.is_ascii()
        || &s[4..5] != "-"
        || &s[7..8] != "-"
        || &s[10..11] != "T"
        || &s[13..14] != ":"
        || &s[16..17] != ":"
    {
        return None;
    }
    let num = |a, b| s.get(a..b)?.parse::<i64>().ok();
    let (year, month, day, hour, minute, second) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(0..24).contains(&hour)
        || !(0..60).contains(&minute)
        || !(0..60).contains(&second)
    {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > days[month as usize - 1] {
        return None;
    }
    let fraction = if s.len() == 19 {
        ""
    } else {
        s.get(19..)?.strip_prefix('.')?
    };
    if fraction.len() > 9
        || (s.len() > 19 && fraction.is_empty())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let millis = fraction
        .bytes()
        .take(3)
        .enumerate()
        .map(|(i, b)| (b - b'0') as i64 * [100, 10, 1][i])
        .sum::<i64>();
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(((days * 24 + hour) * 60 + minute) * 60 * 1000 + second * 1000 + millis).ok()
}

#[derive(Debug)]
struct Event {
    value: Value,
    time: u64,
    id: u32,
    provider: String,
    object: Option<String>,
    pid: Option<u32>,
    image: Option<String>,
    sid: Option<String>,
    failure: bool,
}
fn parse_event(xml: &str) -> Probe<Event> {
    if xml.len() > XML_LIMIT {
        return Err(invalid("Rendered XML exceeds limit"));
    }
    let doc = Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: false,
            nodes_limit: 4096,
            ..Default::default()
        },
    )
    .map_err(|_| invalid("Malformed or unsupported event XML"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "Event" || root.tag_name().namespace() != Some(NS) {
        return Err(invalid("Unexpected event namespace"));
    }
    let system = field(root, "System").ok_or_else(|| invalid("Missing System"))?;
    let text = |name| field(system, name).and_then(|n| n.text());
    let id = text("EventID")
        .and_then(numeric)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| invalid("Missing event ID"))?;
    let record = text("EventRecordID")
        .and_then(numeric)
        .ok_or_else(|| invalid("Missing record ID"))?;
    let provider = field(system, "Provider")
        .and_then(|n| n.attribute("Name"))
        .and_then(|s| bounded(s, 256))
        .ok_or_else(|| invalid("Missing provider"))?;
    let time = field(system, "TimeCreated")
        .and_then(|n| n.attribute("SystemTime"))
        .and_then(timestamp)
        .ok_or_else(|| invalid("Invalid event time"))?;
    let failure = text("Keywords")
        .and_then(numeric)
        .is_some_and(|k| k & 0x0010_0000_0000_0000 != 0);
    let mut data = std::collections::BTreeMap::new();
    if let Some(event_data) = field(root, "EventData") {
        for node in event_data.children().filter(|n| n.is_element()) {
            if node.tag_name().name() != "Data" || node.tag_name().namespace() != Some(NS) {
                continue;
            }
            let Some(name) = node.attribute("Name") else {
                continue;
            };
            let limit = match name {
                "ObjectName" | "TargetObject" | "ProcessName" | "Image" => 2048,
                "SubjectUserSid" | "ProcessId" | "ProcessID" | "AccessMask" | "Status" => 256,
                "EventType" if provider == SYSMON => 256,
                "OldSd" | "NewSd" if id == 4670 && provider == SECURITY => 2048,
                _ => continue,
            };
            // Duplicate allowlisted fields are ambiguous and cannot be evidence.
            if data.contains_key(name) {
                return Err(invalid("Duplicate event field"));
            }
            if let Some(value) = node.text().and_then(|s| bounded(s, limit)) {
                data.insert(name, value);
            }
        }
    }
    let get = |names: &[&str]| names.iter().find_map(|name| data.get(name).cloned());
    let object = get(&["ObjectName", "TargetObject"]);
    let image = get(&["ProcessName", "Image"]);
    let sid = get(&["SubjectUserSid"]);
    let pid = get(&["ProcessId", "ProcessID"])
        .as_deref()
        .and_then(numeric)
        .and_then(|n| u32::try_from(n).ok());
    let mut value = json!({"recordId":record.to_string(),"eventId":id,"provider":provider,"timeMs":time,"attribution":"unsupported"});
    for (key, val) in [
        ("objectName", &object),
        ("processName", &image),
        ("subjectSid", &sid),
    ] {
        if let Some(val) = val {
            value[key] = json!(val);
        }
    }
    if let Some(pid) = pid {
        value["processId"] = json!(pid);
    }
    for (source, key) in [
        ("OldSd", "oldSd"),
        ("NewSd", "newSd"),
        ("AccessMask", "accessMask"),
        ("Status", "status"),
        ("EventType", "operation"),
    ] {
        if let Some(val) = data.get(source) {
            value[key] = json!(val);
        }
    }
    if provider == SECURITY {
        value["operation"] = json!(match id {
            4656 if failure => "access_denied",
            4656 => "handle-request",
            4663 => "access-performed",
            4657 => "value-modified",
            4670 => "permissions-changed",
            _ => "unknown",
        });
    }
    Ok(Event {
        value,
        time,
        id,
        provider,
        object,
        pid,
        image,
        sid,
        failure,
    })
}

fn correlate(event: &Event, target: &Target) -> Option<Value> {
    if event.time.abs_diff(target.observed) > WINDOW {
        return None;
    }
    let object = normalized(event.object.as_deref()?);
    let key = normalized(&target.path);
    let is_value = (event.provider == SYSMON && matches!(event.id, 13 | 14))
        || (event.provider == SECURITY && event.id == 4657);
    let value_path = normalized(&format!("{}\\{}", target.path, target.name));
    let ancestor = target
        .ancestor
        .as_deref()
        .is_some_and(|p| normalized(p) == object);
    if object != key && !(is_value && object == value_path) && !ancestor {
        return None;
    }
    let acl_change = event.provider == SECURITY && event.id == 4670;
    if event.provider == SECURITY && event.id == 4656 {
        // A denial must identify the exact failed target and the verified caller.
        // Other events retain optional image/SID checks below.
        if !event.failure
            || object != key
            || !event
                .image
                .as_ref()
                .is_some_and(|image| image.eq_ignore_ascii_case(&target.image))
            || !event
                .sid
                .as_ref()
                .is_some_and(|sid| sid.eq_ignore_ascii_case(&target.sid))
        {
            return None;
        }
    }
    let basis = if acl_change {
        // The actor changing the ACL is commonly a different process/user from the denied caller.
        // Path/time proximity does not establish who historically set the blocking ACL.
        if ancestor {
            "ancestor-path+time;acl-actor-not-failure-process"
        } else {
            "target-path+time;acl-actor-not-failure-process"
        }
    } else {
        // Provider Execution PID is the logging service, never the registry caller.
        if event.pid != Some(target.pid)
            || event.time < target.birth_ms
            || event.time > target.verified_until_ms
        {
            return None;
        }
        if event
            .image
            .as_ref()
            .is_some_and(|p| !p.eq_ignore_ascii_case(&target.image))
        {
            return None;
        }
        if event
            .sid
            .as_ref()
            .is_some_and(|sid| !sid.eq_ignore_ascii_case(&target.sid))
        {
            return None;
        }
        if ancestor {
            "ancestor-path+time+pid+verified-process-lifetime"
        } else {
            "target-path+time+pid+verified-process-lifetime"
        }
    };
    Some(
        json!({"failureEventId":target.id,"basis":basis,"timeDeltaMs":event.time as i64-target.observed as i64}),
    )
}

fn render(handle: EVT_HANDLE) -> Probe<String> {
    let (mut used, mut count) = (0, 0);
    unsafe {
        EvtRender(
            0,
            handle,
            EvtRenderEventXml,
            0,
            null_mut(),
            &mut used,
            &mut count,
        );
    }
    let code = unsafe { GetLastError() };
    if code != ERROR_INSUFFICIENT_BUFFER {
        return Err(Failure::new(
            code,
            "events.render",
            "Could not size event XML",
        ));
    }
    if used == 0 || used as usize > XML_LIMIT || used % 2 != 0 {
        return Err(Failure::new(
            122,
            "events.render",
            "Event XML exceeds byte limit",
        ));
    }
    let mut buffer = vec![0u16; used as usize / 2];
    if unsafe {
        EvtRender(
            0,
            handle,
            EvtRenderEventXml,
            used,
            buffer.as_mut_ptr().cast(),
            &mut used,
            &mut count,
        )
    } == 0
    {
        return Err(error("events.render"));
    }
    if used as usize > buffer.len() * 2 || used < 2 {
        return Err(invalid("Invalid rendered length"));
    }
    String::from_utf16(&buffer[..used as usize / 2 - 1])
        .map_err(|_| invalid("Invalid event UTF-16"))
}

fn policy() -> Probe<Value> {
    // Audit Registry subcategory, documented by Windows audit policy GUID definitions.
    let guid = GUID {
        data1: 0x0cce921e,
        data2: 0x69ae,
        data3: 0x11d9,
        data4: [0xbe, 0xd3, 0x50, 0x50, 0x54, 0x50, 0x30, 0x30],
    };
    let mut raw = null_mut();
    if !unsafe { AuditQuerySystemPolicy(&guid, 1, &mut raw) } {
        return Err(error("events.auditPolicy"));
    }
    if raw.is_null() {
        return Err(invalid("Missing audit policy"));
    }
    struct AuditAllocation(*mut AUDIT_POLICY_INFORMATION);
    impl Drop for AuditAllocation {
        fn drop(&mut self) {
            unsafe {
                AuditFree(self.0.cast());
            }
        }
    }
    let allocation = AuditAllocation(raw);
    let bits = unsafe { (*allocation.0).AuditingInformation };
    Ok(
        json!({"registrySuccess":bits & 1 != 0,"registryFailure":bits & 2 != 0,"scope":"current-system-policy","sacl":"not-read"}),
    )
}

fn enumerate(deadline: Instant) -> (Vec<String>, Value) {
    let mut names = vec![
        "Security".into(),
        "Microsoft-Windows-Sysmon/Operational".into(),
        "Microsoft-Windows-Windows Defender/Operational".into(),
    ];
    let raw = unsafe { EvtOpenChannelEnum(0, 0) };
    if raw == 0 {
        return (
            names,
            outcome::<Value>(Err(error("events.channelEnumeration"))),
        );
    }
    let handle = EventHandle(raw);
    let mut buffer = vec![0u16; 1024];
    for scanned in 0..512 {
        if Instant::now() >= deadline {
            return (
                names,
                outcome::<Value>(Err(Failure::new(
                    1460,
                    "events.channelEnumeration",
                    "Collection deadline reached",
                ))),
            );
        }
        let mut used = 0;
        if unsafe {
            EvtNextChannelPath(
                handle.0,
                buffer.len() as u32,
                buffer.as_mut_ptr(),
                &mut used,
            )
        } == 0
        {
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_ITEMS {
                return (
                    names,
                    outcome(Ok(json!({"scanned":scanned,"truncated":false}))),
                );
            }
            return (
                names,
                outcome::<Value>(Err(Failure::new(
                    code,
                    "events.channelEnumeration",
                    "Channel enumeration incomplete",
                ))),
            );
        }
        if used == 0 || used as usize > buffer.len() {
            return (
                names,
                outcome::<Value>(Err(invalid("Invalid channel name length"))),
            );
        }
        let Ok(name) = String::from_utf16(&buffer[..used as usize - 1]) else {
            continue;
        };
        let lower = name.to_lowercase();
        if name.len() <= 256
            && (lower.contains("360") || lower.contains("qihoo") || lower.contains("奇虎"))
            && !names.contains(&name)
        {
            names.push(name);
            if names.len() == 8 {
                return (
                    names,
                    outcome(Ok(json!({"scanned":scanned+1,"truncated":true}))),
                );
            }
        }
    }
    (names, outcome(Ok(json!({"scanned":512,"truncated":true}))))
}
fn channel_configuration(name: &str) -> Probe<Value> {
    let raw = unsafe { EvtOpenChannelConfig(0, wide(name).as_ptr(), 0) };
    if raw == 0 {
        return Err(error("events.channelConfig"));
    }
    let handle = EventHandle(raw);
    let mut value: EVT_VARIANT = unsafe { std::mem::zeroed() };
    let mut used = 0;
    if unsafe {
        EvtGetChannelConfigProperty(
            handle.0,
            EvtChannelConfigEnabled,
            0,
            std::mem::size_of::<EVT_VARIANT>() as u32,
            &mut value,
            &mut used,
        )
    } == 0
    {
        return Err(error("events.channelConfig"));
    }
    if value.Type != EvtVarTypeBoolean as u32 {
        return Err(invalid("Invalid channel enabled property"));
    }
    Ok(json!({"enabled":unsafe { value.Anonymous.BooleanVal } != 0}))
}
fn query_text(name: &str, targets: &[Target], now: u64) -> String {
    let ids = if name == "Security" {
        "((EventID=4656 and band(Keywords,4503599627370496)) or EventID=4663 or EventID=4657 or EventID=4670) and "
    } else if name == "Microsoft-Windows-Sysmon/Operational" {
        "(EventID=12 or EventID=13 or EventID=14) and "
    } else {
        ""
    };
    let selects = targets
        .iter()
        .map(|t| {
            let age = now as i64 - t.observed as i64;
            let path = name.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");
            // Separate selectors avoid the Event Log XPath 20-expression limit for eight probes.
            format!(
                "<Select Path=\"{path}\">*[System[{ids}TimeCreated[timediff(@SystemTime) &gt;= {} and timediff(@SystemTime) &lt;= {}]]]</Select>",
                (age - WINDOW as i64).max(0),
                age + WINDOW as i64
            )
        })
        .collect::<String>();
    if targets.is_empty() {
        "*[System[EventID=0]]".into()
    } else {
        format!("<QueryList><Query Id=\"0\">{selects}</Query></QueryList>")
    }
}
fn channel(
    name: &str,
    targets: &[Target],
    deadline: Instant,
    now: u64,
    count: &mut usize,
    bytes: &mut usize,
) -> Value {
    let mut result = json!({"name":name,"status":"collected","scanned":0,"events":[]});
    let fail = |result: &mut Value, failure: Failure| {
        result["status"] = json!(if result["scanned"].as_u64().unwrap_or(0) > 0 {
            "partial"
        } else {
            "unavailable"
        });
        result["code"] = json!(failure.code);
        result["reason"] = json!(format!("{}: {}", failure.stage, failure.error));
    };
    result["configuration"] = outcome(channel_configuration(name));
    if result["configuration"]["ok"] != true {
        result["status"] = json!("partial");
        result["reason"] =
            json!("Channel configuration unavailable; attempting retained event query");
    } else if result["configuration"]["value"]["enabled"] == false {
        result["status"] = json!("partial");
        result["reason"] =
            json!("Channel currently disabled; retained records may still be readable");
    }
    let raw = unsafe {
        EvtQuery(
            0,
            wide(name).as_ptr(),
            wide(&query_text(name, targets, now)).as_ptr(),
            EvtQueryChannelPath | EvtQueryReverseDirection,
        )
    };
    if raw == 0 {
        fail(&mut result, error("events.query"));
        return result;
    }
    let query = EventHandle(raw);
    if targets.is_empty() {
        result["status"] = json!("unavailable");
        result["reason"] = json!("Channel readable; no probes with usable time and identity");
        return result;
    }
    let mut seen = HashSet::new();
    for scanned in 0..128 {
        if Instant::now() >= deadline || *count >= MAX_EVENTS || *bytes >= EVIDENCE_LIMIT {
            fail(
                &mut result,
                Failure::new(
                    122,
                    "events.limit",
                    "Deadline, event count or evidence byte limit reached",
                ),
            );
            return result;
        }
        let (mut raw, mut returned) = (0, 0);
        if unsafe { EvtNext(query.0, 1, &mut raw, 50, 0, &mut returned) } == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_NO_MORE_ITEMS {
                fail(
                    &mut result,
                    Failure::new(code, "events.next", "Event enumeration incomplete"),
                );
            }
            return result;
        }
        let event_handle = EventHandle(raw);
        if returned != 1 || raw == 0 {
            fail(&mut result, invalid("Missing event handle"));
            return result;
        }
        result["scanned"] = json!(scanned + 1);
        let event = match render(event_handle.0).and_then(|xml| parse_event(&xml)) {
            Ok(event) => event,
            Err(e) => {
                fail(&mut result, e);
                continue;
            }
        };
        if (name == "Security" && event.provider != SECURITY)
            || (name == "Microsoft-Windows-Sysmon/Operational" && event.provider != SYSMON)
        {
            continue;
        }
        if !seen.insert(event.value["recordId"].clone().to_string()) {
            continue;
        }
        for target in targets {
            if let Some(correlation) = correlate(&event, target) {
                let mut value = event.value.clone();
                value["correlation"] = correlation;
                let size = serde_json::to_vec(&value).unwrap_or_default().len();
                if *bytes + size > EVIDENCE_LIMIT {
                    fail(
                        &mut result,
                        Failure::new(122, "events.limit", "Evidence byte limit reached"),
                    );
                    return result;
                }
                result["events"].as_array_mut().unwrap().push(value);
                *count += 1;
                *bytes += size;
                break; // A log record is uploaded at most once, even for duplicate probes.
            }
        }
    }
    fail(
        &mut result,
        Failure::new(
            122,
            "events.limit",
            "128 event scan limit reached; absence is inconclusive",
        ),
    );
    result
}

fn empty() -> Value {
    json!({"schemaVersion":1,"status":"unavailable","reason":"Collection has not completed","channels":[],"probes":[],
        "auditPolicy":outcome::<Value>(Err(Failure::new(1460,"events.auditPolicy","Not collected"))),
        "channelEnumeration":outcome::<Value>(Err(Failure::new(1460,"events.channelEnumeration","Not collected"))),
        "limits":{"windowMs":WINDOW,"maxEvents":MAX_EVENTS,"maxChannels":8,"maxScanPerChannel":128},"attribution":"unsupported"})
}
fn collect_inner(
    raws: Vec<Value>,
    registry: Vec<Value>,
    now: u64,
    snapshot: Arc<Mutex<Value>>,
) -> Value {
    let deadline = Instant::now() + Duration::from_millis(6500);
    let mut result = empty();
    let publish = |value: &Value| {
        if let Ok(mut shared) = snapshot.lock() {
            *shared = value.clone();
        }
    };
    let mut targets = Vec::new();
    for raw in raws.iter().take(8) {
        let id = crate::protocol::echo_id(raw, "eventId", 128);
        let mut probe = json!({"failureEventId":id,"status":"unavailable"});
        if let Some(observed) = raw
            .get("observedAtMs")
            .and_then(Value::as_u64)
            .filter(|ms| *ms <= 9_007_199_254_740_991)
        {
            probe["windowStartMs"] = json!(observed.saturating_sub(WINDOW));
            probe["windowEndMs"] = json!(observed.saturating_add(WINDOW));
        }
        let target = (|| -> Probe<Target> {
            let request = registry_request(raw)?;
            let observed = request.observed_at_ms.ok_or_else(|| {
                Failure::new(
                    87,
                    "events.time",
                    "observedAtMs absent; historical attempt cannot be correlated",
                )
            })?;
            if observed > now.saturating_add(5000) || now.saturating_sub(observed) > MAX_AGE {
                return Err(Failure::new(
                    87,
                    "events.time",
                    "Attempt is future-dated or older than the 7-day collection horizon",
                ));
            }
            let verified_until_ms = crate::observed_at_ms();
            let (sid, image, birth) = crate::windows::evidence_identity(&request)?;
            let birth_ms = birth
                .checked_sub(116_444_736_000_000_000)
                .ok_or_else(|| invalid("Process birth predates Unix epoch"))?
                / 10_000;
            if observed < birth_ms {
                return Err(Failure::new(
                    13,
                    "events.identity",
                    "Attempt predates verified process birth",
                ));
            }
            let path = if request.path.is_empty() {
                format!("HKEY_USERS\\{sid}")
            } else {
                format!("HKEY_USERS\\{sid}\\{}", request.path)
            };
            let ancestor = registry
                .iter()
                .find(|r| r["eventId"] == request.event_id && r["value"]["ancestorUsed"] == true)
                .and_then(|r| r["value"]["checkedPath"].as_str())
                .map(str::to_owned);
            Ok(Target {
                id: request.event_id,
                pid: request.pid,
                birth_ms,
                verified_until_ms,
                observed,
                sid,
                image,
                path,
                name: request.name,
                ancestor,
            })
        })();
        match target {
            Ok(target) => {
                probe["status"] = json!("ready");
                probe["windowStartMs"] = json!(target.observed.saturating_sub(WINDOW));
                probe["windowEndMs"] = json!(target.observed.saturating_add(WINDOW));
                targets.push(target);
            }
            Err(e) => {
                probe["code"] = json!(e.code);
                probe["reason"] = json!(format!("{}: {}", e.stage, e.error));
            }
        }
        result["probes"].as_array_mut().unwrap().push(probe);
        publish(&result);
        if Instant::now() >= deadline {
            return result;
        }
    }
    result["auditPolicy"] = outcome(policy());
    publish(&result);
    let (names, enumeration) = enumerate(deadline);
    result["channelEnumeration"] = enumeration;
    publish(&result);
    let (mut count, mut bytes) = (0, 0);
    for name in names {
        if Instant::now() >= deadline {
            result["reason"] = json!("Collection deadline reached");
            break;
        }
        result["channels"].as_array_mut().unwrap().push(channel(
            &name,
            &targets,
            deadline,
            crate::observed_at_ms(),
            &mut count,
            &mut bytes,
        ));
        publish(&result);
    }
    let channels = result["channels"].as_array().unwrap();
    let readable = channels.iter().any(|c| c["status"] != "unavailable");
    let incomplete = channels.iter().any(|c| c["status"] != "collected")
        || result["auditPolicy"]["ok"] != true
        || result["channelEnumeration"]["ok"] != true
        || result["channelEnumeration"]["value"]["truncated"] == true
        || targets.len() != raws.len()
        || Instant::now() >= deadline;
    result["status"] = json!(if !readable {
        "unavailable"
    } else if incomplete {
        "partial"
    } else {
        "collected"
    });
    result["reason"] = json!(
        "Bounded records only; missing events do not exclude registry callbacks or identify who originally set the ACL. Current audit policy does not establish historical auditing or SACL coverage."
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(id: u32, provider: &str, keywords: &str, extra: &str) -> String {
        format!(
            r#"<e:Event xmlns:e="{NS}"><e:System><e:Provider Name="{provider}"/><e:EventID>{id}</e:EventID><e:EventRecordID>123</e:EventRecordID><e:TimeCreated SystemTime="2026-01-02T03:04:05.1234567Z"/><e:Keywords>{keywords}</e:Keywords><e:Execution ProcessID="999"/></e:System><e:EventData><e:Data Name="ObjectName">\REGISTRY\USER\S-1-5-21-1\Software\Policies</e:Data><e:Data Name="ProcessId">0x2a</e:Data><e:Data Name="ProcessName">C:\app.exe</e:Data><e:Data Name="SubjectUserSid">S-1-5-21-1</e:Data>{extra}</e:EventData><e:RenderingInfo><e:Message>MESSAGE_SECRET</e:Message></e:RenderingInfo></e:Event>"#
        )
    }
    fn target() -> Target {
        Target {
            id: "failure-1".into(),
            pid: 42,
            birth_ms: timestamp("2026-01-02T03:00:00Z").unwrap(),
            verified_until_ms: timestamp("2026-01-02T03:05:00Z").unwrap(),
            observed: timestamp("2026-01-02T03:04:05.123Z").unwrap(),
            sid: "S-1-5-21-1".into(),
            image: r"C:\app.exe".into(),
            path: r"HKEY_USERS\S-1-5-21-1\Software\Policies\ActiveDesktop".into(),
            name: "Setting".into(),
            ancestor: Some(r"HKEY_USERS\S-1-5-21-1\Software\Policies".into()),
        }
    }
    #[test]
    fn allowlist_ignores_values_messages_groups_and_commands_and_decodes_entities() {
        let secrets = [
            "CommandLine",
            "ParentCommandLine",
            "OldValue",
            "NewValue",
            "Details",
            "Hashes",
            "PrivilegeList",
            "GroupMembership",
            "ObjectValueName",
            "ArbitraryField",
        ];
        let mut extra = secrets
            .iter()
            .map(|name| format!("<e:Data Name=\"{name}\">SECRET_{name}</e:Data>"))
            .collect::<String>();
        extra.push_str("<e:Data Name=\"OldSd\">O:SYD:(A;;KR;;;SY)</e:Data><e:Data Name=\"NewSd\">O:SYD:(A;;KA;;;SY)</e:Data>");
        let event = parse_event(&fixture(4670, SECURITY, "0x8020000000000000", &extra)).unwrap();
        let encoded = serde_json::to_string(&event.value).unwrap();
        assert!(!encoded.contains("SECRET"));
        assert_eq!(event.value["oldSd"], "O:SYD:(A;;KR;;;SY)");
        assert_eq!(event.value["processId"], 42); // Not the provider Execution ProcessID.
        let xml = fixture(4656, SECURITY, "0x8010000000000000", "")
            .replace("C:\\app.exe", "C:\\A&amp;B.exe");
        assert_eq!(
            parse_event(&xml).unwrap().image.as_deref(),
            Some(r"C:\A&B.exe")
        );
        let non_acl = parse_event(&fixture(4657, SECURITY, "0x8020000000000000", &extra)).unwrap();
        assert!(non_acl.value.get("oldSd").is_none());
        let vendor = parse_event(&fixture(4670, "Qihoo-Example", "0", &extra)).unwrap();
        assert!(vendor.value.get("oldSd").is_none());
        assert_eq!(vendor.value["attribution"], "unsupported");
    }
    fn exact_denial_fixture() -> String {
        fixture(4656, SECURITY, "0x8010000000000000", "").replace(
            r"Software\Policies</e:Data>",
            r"Software\Policies\ActiveDesktop</e:Data>",
        )
    }
    #[test]
    fn denial_requires_security_failure_and_pid_lifetime_hive_and_image() {
        let ancestor = parse_event(&fixture(4656, SECURITY, "0x8010000000000000", "")).unwrap();
        assert!(correlate(&ancestor, &target()).is_none());
        let event = parse_event(&exact_denial_fixture()).unwrap();
        let mut t = target();
        assert_eq!(event.value["operation"], "access_denied");
        assert!(correlate(&event, &t).is_some());
        assert!(
            correlate(
                &parse_event(
                    &exact_denial_fixture().replace("0x8010000000000000", "0x8020000000000000"),
                )
                .unwrap(),
                &t
            )
            .is_none()
        );
        t.birth_ms = event.time + 1;
        assert!(correlate(&event, &t).is_none());
        t = target();
        t.verified_until_ms = event.time - 1;
        assert!(correlate(&event, &t).is_none());
        t = target();
        t.pid = 999;
        assert!(correlate(&event, &t).is_none());
        t = target();
        t.image = r"C:\other.exe".into();
        assert!(correlate(&event, &t).is_none());
        t = target();
        t.sid = "S-1-5-21-2".into();
        assert!(correlate(&event, &t).is_none());
        t = target();
        t.path = r"HKU\S-1-5-21-2\Software\Policies".into();
        t.ancestor = None;
        assert!(correlate(&event, &t).is_none());
        t = target();
        t.observed += WINDOW + 1;
        assert!(correlate(&event, &t).is_none());
        let performed = parse_event(&fixture(4663, SECURITY, "0x8020000000000000", "")).unwrap();
        assert_eq!(performed.value["operation"], "access-performed");
    }
    #[test]
    fn denial_rejects_missing_image() {
        let xml =
            exact_denial_fixture().replace(r#"<e:Data Name="ProcessName">C:\app.exe</e:Data>"#, "");
        let event = parse_event(&xml).unwrap();
        assert!(event.image.is_none());
        assert!(correlate(&event, &target()).is_none());
    }
    #[test]
    fn denial_rejects_missing_sid() {
        let xml = exact_denial_fixture()
            .replace(r#"<e:Data Name="SubjectUserSid">S-1-5-21-1</e:Data>"#, "");
        let event = parse_event(&xml).unwrap();
        assert!(event.sid.is_none());
        assert!(correlate(&event, &target()).is_none());
    }
    #[test]
    fn denial_rejects_mismatched_pid() {
        let event = parse_event(&exact_denial_fixture().replace("0x2a", "0x80")).unwrap();
        assert_eq!(event.pid, Some(128));
        assert!(correlate(&event, &target()).is_none());
    }
    #[test]
    fn denial_accepts_exact_match_with_case_insensitive_identity_and_inclusive_time_bounds() {
        let xml = exact_denial_fixture()
            .replace(r"C:\app.exe", r"c:\APP.EXE")
            .replace(">S-1-5-21-1<", ">s-1-5-21-1<");
        let event = parse_event(&xml).unwrap();
        let mut t = target();
        let correlation = correlate(&event, &t).unwrap();
        assert_eq!(event.value["operation"], "access_denied");
        assert_eq!(
            correlation["basis"],
            "target-path+time+pid+verified-process-lifetime"
        );
        t.birth_ms = event.time;
        t.verified_until_ms = event.time;
        for observed in [event.time - WINDOW, event.time + WINDOW] {
            t.observed = observed;
            assert!(correlate(&event, &t).is_some());
        }
        for observed in [event.time - WINDOW - 1, event.time + WINDOW + 1] {
            t.observed = observed;
            assert!(correlate(&event, &t).is_none());
        }
    }
    #[test]
    fn acl_changer_can_be_a_different_actor_but_path_and_time_still_must_match() {
        let xml = fixture(4670, SECURITY, "0x8020000000000000", "")
            .replace("0x2a", "0x80")
            .replace(r"C:\app.exe", r"C:\installer.exe")
            .replace(">S-1-5-21-1<", ">S-1-5-18<");
        let event = parse_event(&xml).unwrap();
        let correlation = correlate(&event, &target()).unwrap();
        assert!(
            correlation["basis"]
                .as_str()
                .unwrap()
                .contains("acl-actor-not-failure-process")
        );
        assert_eq!(event.value["subjectSid"], "S-1-5-18");
        assert_eq!(event.value["processId"], 128);
        let mut unrelated = target();
        unrelated.ancestor = None;
        assert!(correlate(&event, &unrelated).is_none());
        let mut outside_lifetime = target();
        outside_lifetime.birth_ms = event.time + 1;
        outside_lifetime.verified_until_ms = event.time - 1;
        assert!(correlate(&event, &outside_lifetime).is_some());
        let mut outside_window = target();
        outside_window.observed = event.time + WINDOW + 1;
        assert!(correlate(&event, &outside_window).is_none());
    }
    #[test]
    fn non_denial_events_keep_optional_identity_checks_and_basis() {
        for (id, provider) in [(4663, SECURITY), (4657, SECURITY), (12, SYSMON)] {
            let xml = fixture(id, provider, "0x8020000000000000", "")
                .replace(r#"<e:Data Name="ProcessName">C:\app.exe</e:Data>"#, "")
                .replace(r#"<e:Data Name="SubjectUserSid">S-1-5-21-1</e:Data>"#, "");
            let event = parse_event(&xml).unwrap();
            assert!(event.image.is_none());
            assert!(event.sid.is_none());
            assert_eq!(
                correlate(&event, &target()).unwrap()["basis"],
                "ancestor-path+time+pid+verified-process-lifetime"
            );
        }
    }
    #[test]
    fn default_namespace_and_sysmon_value_targets_are_supported_without_details() {
        let xml = fixture(13,SYSMON,"0", "<e:Data Name=\"Details\">PRIVATE_REGISTRY_VALUE</e:Data><e:Data Name=\"EventType\">SetValue</e:Data>")
            .replace("e:", "").replace("xmlns:e", "xmlns")
            .replace("Name=\"ObjectName\"", "Name=\"TargetObject\"")
            .replace(r"\REGISTRY\USER\S-1-5-21-1\Software\Policies",r"HKU\S-1-5-21-1\Software\Policies\ActiveDesktop\Setting");
        let event = parse_event(&xml).unwrap();
        assert!(correlate(&event, &target()).is_some());
        assert_eq!(event.value["operation"], "SetValue");
        assert!(!event.value.to_string().contains("PRIVATE_REGISTRY_VALUE"));
        let other = parse_event(&xml.replace("ActiveDesktop\\Setting", "ActiveDesktop\\Unrelated"))
            .unwrap();
        assert!(correlate(&other, &target()).is_none());
        let vendor = parse_event(&fixture(
            1,
            "Qihoo-Example",
            "0",
            "<e:Data Name=\"EventType\">access_denied</e:Data>",
        ))
        .unwrap();
        assert!(vendor.value.get("operation").is_none());
    }

    #[test]
    fn hostile_or_ambiguous_xml_is_rejected_without_entity_expansion() {
        let base = fixture(4656, SECURITY, "0x8010000000000000", "");
        assert!(parse_event(&base.replace(NS, "urn:wrong")).is_err());
        assert!(
            parse_event(&format!(
                "<!DOCTYPE Event [<!ENTITY secret SYSTEM 'file:///secret'>]>{base}"
            ))
            .is_err()
        );
        assert!(
            parse_event(&fixture(
                4656,
                SECURITY,
                "0x8010000000000000",
                "<e:Data Name=\"ProcessId\">999</e:Data>"
            ))
            .is_err()
        );
        assert!(parse_event(&"x".repeat(XML_LIMIT + 1)).is_err());
        assert!(
            parse_event(&base.replace("2026-01-02T03:04:05.1234567Z", "2026-02-30T03:04:05Z"))
                .is_err()
        );
        assert!(parse_event(&base.replace("</e:Event>", "")).is_err());
    }
    #[test]
    fn timestamps_and_queries_are_bounded_and_do_not_interpolate_target_text() {
        assert_eq!(timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(timestamp("1970-01-02T00:00:00.1Z"), Some(86_400_100));
        assert!(timestamp("2024-02-29T23:59:59.9999999Z").is_some());
        for bad in [
            "2025-02-29T00:00:00Z",
            "2026-01-01T00:00:00+01:00",
            "2026-01-01T00:00:60Z",
            "2026-01-01T00:00:00.Z",
        ] {
            assert!(timestamp(bad).is_none());
        }
        let mut t = target();
        t.path = "' or EventID=1".into();
        let query = query_text("Security", &[t.clone()], t.observed);
        assert!(query.contains("band(Keywords,4503599627370496)"));
        assert!(query.contains("&gt;= 0"));
        assert!(query.contains("120000"));
        assert!(!query.contains(&t.path));
    }
}

pub fn collect(raws: &[Value], registry: &[Value], now: u64) -> Value {
    static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    struct ActiveCollector;
    impl Drop for ActiveCollector {
        fn drop(&mut self) {
            ACTIVE.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    if ACTIVE
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        let mut value = empty();
        value["reason"] =
            json!("Previous read-only event collector is still completing an OS call");
        return value;
    }
    let snapshot = Arc::new(Mutex::new(empty()));
    let shared = Arc::clone(&snapshot);
    let (sender, receiver) = mpsc::sync_channel(1);
    let (raws, registry) = (raws.to_vec(), registry.to_vec());
    // EvtQuery/Render have no timeout parameter. Isolate blocking OS reads; CLI exits after reply.
    // Worker owns all handles and closes them on return, including after receiver timeout.
    let spawn = std::thread::Builder::new()
        .name("registry-evidence".into())
        .spawn(move || {
            let _active = ActiveCollector;
            let result = collect_inner(raws, registry, now, shared);
            let _ = sender.send(result);
        });
    if spawn.is_err() {
        ACTIVE.store(false, std::sync::atomic::Ordering::Release);
        let mut value = empty();
        value["reason"] = json!("Could not start event collection worker");
        return value;
    }
    match receiver.recv_timeout(Duration::from_millis(7000)) {
        Ok(result) => result,
        Err(_) => {
            let mut result = snapshot
                .lock()
                .map(|v| v.clone())
                .unwrap_or_else(|_| empty());
            result["status"] = json!(
                if result["channels"].as_array().is_some_and(|c| !c.is_empty()) {
                    "partial"
                } else {
                    "unavailable"
                }
            );
            result["reason"] =
                json!("7000 ms collector deadline reached; only completed reads are included");
            result
        }
    }
}
