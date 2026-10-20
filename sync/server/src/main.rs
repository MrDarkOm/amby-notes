//! The `amby-sync-server` command (П38): `serve` (the default), `user add|list|remove`,
//! `maintenance`, `backup`, and `healthcheck` for the container.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use amby_sync_server::admin::{self, AdminError};
use amby_sync_server::{build_app, maintenance, AppState, Config, SystemClock};

/// How often the server cleans up (П37).
const MAINTENANCE_EVERY: Duration = Duration::from_secs(600);
/// How long open requests and event streams get to finish after a stop signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = args.iter().any(|arg| arg == "--json");
    let yes = args.iter().any(|arg| arg == "--yes");
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|arg| !arg.starts_with("--"))
        .collect();

    if matches!(words.as_slice(), ["healthcheck"]) {
        return healthcheck();
    }
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("cannot start: {error}");
            return ExitCode::from(1);
        }
    };
    let state = match AppState::try_open(config, Arc::new(SystemClock)) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("cannot open the data directory: {error}");
            return ExitCode::from(1);
        }
    };

    match words.as_slice() {
        [] | ["serve"] => serve(state),
        ["user", "add", name] => report(admin::user_add(&state, name).map(|added| {
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
                println!("User {}: one-time enrolment code", added.username);
                println!("  {}", added.enroll_code);
                println!(
                    "Valid for {} hours; it works once.",
                    state.config.enroll_code_hours
                );
            }
        })),
        ["user", "list"] => report(admin::user_list(&state).map(|users| {
            if json {
                let list: Vec<_> = users
                    .iter()
                    .map(|user| {
                        serde_json::json!({
                            "username": user.username,
                            "has_password": user.has_password,
                            "enroll_expires_ms": user.enroll_expires_ms,
                        })
                    })
                    .collect();
                println!("{}", serde_json::Value::Array(list));
            } else {
                for user in users {
                    let status = if user.has_password {
                        "has a password".to_string()
                    } else {
                        match user.enroll_expires_ms {
                            Some(expires) => {
                                format!("waiting for enrolment, code expires at {expires} ms")
                            }
                            None => "waiting for a new code".to_string(),
                        }
                    };
                    println!("{}\t{status}", user.username);
                }
            }
        })),
        ["user", "remove", name] => {
            if !yes {
                eprintln!("`user remove` deletes the user, devices, spaces and bodies for good; add --yes to confirm");
                return ExitCode::from(2);
            }
            report(admin::user_remove(&state, name))
        }
        ["maintenance"] => match maintenance::run(&state) {
            Ok(done) => {
                println!(
                    "removed: {} bodies without a commit, {} old versions, {} deleted items",
                    done.orphan_blobs, done.versions, done.items
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(1)
            }
        },
        ["backup", target] => report(admin::backup(&state, std::path::Path::new(target))),
        _ => {
            eprintln!(
                "usage: amby-sync-server [serve | user add <name> [--json] | user list [--json] | \
                 user remove <name> --yes | maintenance | backup <dir> | healthcheck]"
            );
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

/// `healthcheck`: asks the server on this machine for `/v1/info`. The image has no `curl`.
fn healthcheck() -> ExitCode {
    let listen = std::env::var("AMBY_SYNC_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let port = listen
        .rsplit(':')
        .next()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(8080);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let attempt = || -> std::io::Result<bool> {
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.write_all(b"GET /v1/info HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut head = [0u8; 12];
        stream.read_exact(&mut head)?;
        Ok(head.ends_with(b" 200"))
    };
    match attempt() {
        Ok(true) => ExitCode::SUCCESS,
        _ => ExitCode::from(1),
    }
}

/// Runs the HTTP server until a stop signal, with the cleanup every ten minutes and once more
/// before the stop (П37).
fn serve(state: AppState) -> ExitCode {
    let listen = state.config.listen.clone();
    let config = state.config.clone();
    if config.public_url.starts_with("http://")
        && !config.public_url.contains("localhost")
        && !config.public_url.contains("127.0.0.1")
        && !config.public_url.contains("[::1]")
    {
        eprintln!(
            "warning: AMBY_SYNC_PUBLIC_URL is plain http://: anything sent can be read on the way. \
             Use https:// unless this is a trusted local network."
        );
    }
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cannot start the runtime: {error}");
            return ExitCode::from(1);
        }
    };
    let code = runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(&listen).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("cannot listen on {listen}: {error}");
                return ExitCode::from(1);
            }
        };
        eprintln!("amby-sync-server listening on {listen}");

        let cleanup_state = state.clone();
        let cleaner = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(MAINTENANCE_EVERY);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                run_maintenance(&cleanup_state).await;
            }
        });

        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            wait_for_signal().await;
            let _ = stop.send(true);
        });
        let mut graceful = stopped.clone();
        let app = build_app(state.clone());
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = graceful.changed().await;
        });
        let outcome = tokio::select! {
            result = server => Some(result),
            // Open event streams never end by themselves; after the grace period the stop is
            // forced.
            () = async {
                let _ = stopped.changed().await;
                tokio::time::sleep(SHUTDOWN_GRACE).await;
            } => None,
        };
        cleaner.abort();
        run_maintenance(&state).await;
        match outcome {
            Some(Err(error)) => {
                eprintln!("server stopped: {error}");
                ExitCode::from(1)
            }
            _ => ExitCode::SUCCESS,
        }
    });
    // Open streams may still hold tasks; the process is done.
    runtime.shutdown_timeout(Duration::from_secs(2));
    code
}

async fn run_maintenance(state: &AppState) {
    let state = state.clone();
    match tokio::task::spawn_blocking(move || maintenance::run(&state)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("maintenance failed: {error}"),
        Err(error) => eprintln!("maintenance failed: {error}"),
    }
}

/// Waits for Ctrl-C or, on Unix, for `SIGTERM` (what `docker stop` sends).
async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
