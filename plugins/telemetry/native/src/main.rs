// Deliberately a console executable: the JS parent supplies windowsHide and closes stdin.
use chord_observer::{encode_response, failure_response, observe, protocol::read_bounded};
use std::io::{self, Write};

fn main() {
    let response = match read_bounded(io::stdin().lock()) {
        Ok(bytes) => observe(&bytes),
        Err(error) => failure_response(error),
    };
    let failed = response.get("ok").and_then(serde_json::Value::as_bool) == Some(false);
    let bytes = encode_response(&response);
    if io::stdout().lock().write_all(&bytes).is_err() {
        std::process::exit(1);
    }
    if failed {
        std::process::exit(2);
    }
}
