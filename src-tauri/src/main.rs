// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "native-contract")]
    amby_notes_lib::run_native_contract();
    #[cfg(not(feature = "native-contract"))]
    amby_notes_lib::run()
}
