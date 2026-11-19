// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(target_os = "linux", not(feature = "native-contract")))]
    run_bundled_cli();
    #[cfg(feature = "native-contract")]
    amby_notes_lib::run_native_contract();
    #[cfg(not(feature = "native-contract"))]
    amby_notes_lib::run()
}

// AppImage exposes only its desktop entry point. With this flag the same
// AppImage passes control and stdio straight to the bundled CLI.
#[cfg(all(target_os = "linux", not(feature = "native-contract")))]
fn run_bundled_cli() {
    use std::os::unix::process::CommandExt;

    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--amby-cli")) {
        return;
    }
    let result = std::env::current_exe().map(|desktop| {
        std::process::Command::new(desktop.with_file_name("amby"))
            .args(args)
            .exec()
    });
    let error = match result {
        Ok(error) | Err(error) => error,
    };
    eprintln!("Could not start the bundled Amby CLI: {error}");
    std::process::exit(1);
}
