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
        // Keep the newline in the same append as its record: shutdown and startup
        // can write diagnostics concurrently from different processes.
        let length = bytes.len().min(64 * 1024);
        let mut line = Vec::with_capacity(length + 1);
        line.extend_from_slice(&bytes[..length]);
        line.push(b'\n');
        let _ = file.write_all(&line);
    }
}
