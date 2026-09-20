fn main() {
    println!("cargo:rerun-if-changed=src/build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // Fixed PE/debug timestamps are deterministic with both link.exe and rust-lld.
        // /Brepro hashes can include nondeterministic temporary inputs even when stripped
        // executable code/data are identical, so do not derive the timestamp from them.
        println!("cargo:rustc-link-arg=/timestamp:0");
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            // Rust adds /DEBUG for std NatVis even with strip=true. Suppress the
            // resulting CodeView/PDB identity, which varies with temporary paths.
            println!("cargo:rustc-link-arg=/DEBUG:NONE");
        }
    }
}
