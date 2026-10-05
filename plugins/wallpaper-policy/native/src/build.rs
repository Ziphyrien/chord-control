fn main() {
    println!("cargo:rerun-if-changed=src/build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var("PROFILE").as_deref() == Ok("release")
    {
        println!("cargo:rustc-link-arg=/timestamp:0");
        println!("cargo:rustc-link-arg=/DEBUG:NONE");
    }
}
