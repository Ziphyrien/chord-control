//! Bounded, best-effort diagnostic files; never part of the JSON protocol.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
pub(crate) fn append(path: &Path, bytes: &[u8]) {
    const LIMIT: u64 = 1024 * 1024;
    // Retain the preceding segment for crash context. Guard peers may rotate concurrently;
    // diagnostics are best effort and never determine session liveness.
    if fs::metadata(path).is_ok_and(|meta| meta.len() + bytes.len() as u64 > LIMIT) {
        let previous = path.with_extension("previous.log");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(path, previous);
    }
    if let Ok(mut file) = OpenOptions::new().append(true).create(true).open(path) {
        let _ = file.write_all(&bytes[..bytes.len().min(64 * 1024)]);
        let _ = file.write_all(b"\n");
    }
}
