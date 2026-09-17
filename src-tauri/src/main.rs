#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    match chord_control_lib::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            // Maintenance callers rely on the exit code; no modal dialog can hang NSIS.
            eprintln!("Chord Control: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
