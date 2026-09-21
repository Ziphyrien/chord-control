fn main() {
    println!("cargo:rerun-if-changed=src/build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var("PROFILE").as_deref() == Ok("release")
    {
        // Plugin CI selects Rust's LLVM linker; MSVC ignores /timestamp.
        println!("cargo:rustc-link-arg=/timestamp:0");
        // Rust adds /DEBUG for std NatVis even with strip=true. Suppress the
        // resulting CodeView/PDB identity, which varies with temporary paths.
        println!("cargo:rustc-link-arg=/DEBUG:NONE");
    }
}
