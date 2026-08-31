fn main() {
    tauri_build::build();
    // Library test executables do not receive Tauri's application resource.
    // rfd imports TaskDialogIndirect, which requires Common Controls v6 even
    // when no dialog is opened. Without this manifest cargo test cannot start.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // The app binary already embeds Tauri's full manifest via resource.lib.
        // Disable only its linker-generated copy to avoid duplicate resource 1.
        println!("cargo:rustc-link-arg-bin=amby-notes=/MANIFEST:NO");
    }
}
