//! The `amby-sync-server` command (П38): `serve` (the default), `user add|list|remove`,
//! `maintenance`, `backup`. Stage Э2, step 1: `serve` starts the stub router, the rest fail with
//! `not_implemented`.

use std::process::ExitCode;
use std::sync::Arc;

use amby_sync_server::admin::{self, AdminError};
use amby_sync_server::{build_app, maintenance, AppState, Config, SystemClock};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let json = words.contains(&"--json");
    let config = Config::from_env().unwrap_or_else(|error| {
        // Э2 stub: parsing is not written yet, so the defaults serve the stub router.
        eprintln!("warning: {error}; using the defaults");
        Config::default()
    });
    let state = AppState::open(config, Arc::new(SystemClock));

    match words.as_slice() {
        [] | ["serve"] => serve(state),
        ["user", "add", name, ..] => report(admin::user_add(&state, name).map(|added| {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "username": added.username,
                        "enroll_code": added.enroll_code,
                        "expires_ms": added.expires_ms,
                    })
                );
            } else {
                println!("{}: one-time code {}", added.username, added.enroll_code);
            }
        })),
        ["user", "list", ..] => report(admin::user_list(&state).map(|_| ())),
        ["user", "remove", name, ..] => report(admin::user_remove(&state, name)),
        ["maintenance"] => match maintenance::run(&state) {
            Ok(_) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(1)
            }
        },
        ["backup", target] => report(admin::backup(&state, std::path::Path::new(target))),
        _ => {
            eprintln!("usage: amby-sync-server [serve | user add|list|remove | maintenance | backup <dir>]");
            ExitCode::from(2)
        }
    }
}

/// Prints an administrator error and turns it into the exit code of П38.
fn report(result: Result<(), AdminError>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(u8::try_from(error.exit_code()).unwrap_or(1))
        }
    }
}

/// Runs the HTTP server until the process is stopped.
fn serve(state: AppState) -> ExitCode {
    let listen = state.config.listen.clone();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the runtime: {error}");
            return ExitCode::from(1);
        }
    };
    runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(&listen).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("cannot listen on {listen}: {error}");
                return ExitCode::from(1);
            }
        };
        eprintln!("amby-sync-server (stub) listening on {listen}");
        match axum::serve(listener, build_app(state)).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("server stopped: {error}");
                ExitCode::from(1)
            }
        }
    })
}
