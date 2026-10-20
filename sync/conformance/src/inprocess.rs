//! The server of this repository, started inside the test process on a free local port with
//! its own data directory and a clock the test can move (П37).

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

use amby_sync_server::maintenance::{self, MaintenanceReport};
use amby_sync_server::{build_app, AppState, Config, ManualClock};
use tempfile::TempDir;
use tokio::sync::oneshot;

/// 2026-10-20 12:00:00 UTC, the day the plan was written; any fixed start would do.
pub const START_MS: i64 = 1_792_497_600_000;

struct Running {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

/// A running in-process server.
pub struct InProcess {
    addr: SocketAddr,
    pub clock: Arc<ManualClock>,
    pub state: Arc<RwLock<AppState>>,
    config: Config,
    data_dir: PathBuf,
    _tmp: Option<TempDir>,
    running: Mutex<Running>,
}

impl InProcess {
    /// Starts a server on a fresh temporary data directory.
    pub fn start(adjust: impl FnOnce(&mut Config)) -> Self {
        let tmp = tempfile::tempdir().expect("cannot create a data directory");
        let data_dir = tmp.path().to_path_buf();
        Self::start_in(
            data_dir,
            Some(tmp),
            Arc::new(ManualClock::new(START_MS)),
            adjust,
        )
    }

    /// Starts a server on `data_dir` (a second server on the same directory is a restart of the
    /// first, П10) with the given clock.
    pub fn start_in(
        data_dir: PathBuf,
        tmp: Option<TempDir>,
        clock: Arc<ManualClock>,
        adjust: impl FnOnce(&mut Config),
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("cannot bind a local port");
        let addr = listener.local_addr().expect("no local address");
        let mut config = Config {
            data_dir: data_dir.clone(),
            listen: addr.to_string(),
            public_url: format!("http://{addr}"),
            ..Config::default()
        };
        adjust(&mut config);
        let state = AppState::open(config.clone(), clock.clone());
        let running = spawn(state.clone(), listener);
        Self {
            addr,
            clock,
            state: Arc::new(RwLock::new(state)),
            config,
            data_dir,
            _tmp: tmp,
            running: Mutex::new(running),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Moves the clock of the server (П37).
    pub fn advance(&self, by: Duration) {
        self.clock.advance(by);
    }

    /// One cleanup (П37). A failure fails the test with the reason of the server.
    pub fn run_maintenance(&self) -> MaintenanceReport {
        let state = self.state.read().unwrap().clone();
        maintenance::run(&state).unwrap_or_else(|error| panic!("maintenance failed: {error}"))
    }

    /// `amby-sync-server backup <dir>` against the running server (П38, Р11).
    pub fn backup(&self, dir: &Path) {
        let state = self.state.read().unwrap().clone();
        amby_sync_server::admin::backup(&state, dir)
            .unwrap_or_else(|error| panic!("backup failed: {error:?}"));
    }

    /// Stops the server and starts it again on the same data directory, clock and port
    /// (a restart: П10 says `instance_id` stays).
    pub fn restart(&self) {
        self.stop();
        let listener = TcpListener::bind(self.addr).expect("cannot bind the old port again");
        let state = AppState::open(self.config.clone(), self.clock.clone());
        *self.state.write().unwrap() = state.clone();
        *self.running.lock().unwrap() = spawn(state, listener);
    }

    /// Stops the server, empties the data directory and starts it again: a lost volume or a reset
    /// server (С7). `instance_id` must change (П10).
    pub fn restart_fresh(&self) {
        self.stop();
        for entry in std::fs::read_dir(&self.data_dir).expect("cannot read the data directory") {
            let path = entry.expect("bad directory entry").path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path).expect("cannot remove a directory");
            } else {
                std::fs::remove_file(&path).expect("cannot remove a file");
            }
        }
        let listener = TcpListener::bind(self.addr).expect("cannot bind the old port again");
        let state = AppState::open(self.config.clone(), self.clock.clone());
        *self.state.write().unwrap() = state.clone();
        *self.running.lock().unwrap() = spawn(state, listener);
    }

    fn stop(&self) {
        let mut running = self.running.lock().unwrap();
        if let Some(stop) = running.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for InProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn(state: AppState, listener: TcpListener) -> Running {
    let (stop, stopped) = oneshot::channel::<()>();
    let thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("cannot start the runtime");
        runtime.block_on(async move {
            listener
                .set_nonblocking(true)
                .expect("cannot make the listener non-blocking");
            let listener = tokio::net::TcpListener::from_std(listener).expect("bad listener");
            // Not a graceful shutdown: an open event stream must not hold a restart back.
            tokio::select! {
                _ = axum::serve(listener, build_app(state)) => {}
                _ = stopped => {}
            }
        });
        runtime.shutdown_background();
    });
    Running {
        stop: Some(stop),
        thread: Some(thread),
    }
}
