use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use tauri::Emitter;
use tracing_subscriber::layer::Context;
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;

const MEMORY_LIMIT: usize = 2_000;
const HISTORY_LIMIT: usize = 5_000;
const MAX_EVENT_BYTES: usize = 16 * 1024;
const FILE_LIMIT: u64 = 5 * 1024 * 1024;
const QUEUE_LIMIT: usize = 1_024;
const BARRIER_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn rank(self) -> u8 {
        match self {
            Self::Debug => 0,
            Self::Info => 1,
            Self::Warn => 2,
            Self::Error => 3,
        }
    }

    fn tracing_filter(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    Frontend,
    Backend,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfig {
    pub enabled: bool,
    pub log_level: LogLevel,
    pub log_to_file: bool,
}

impl Default for DebugConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            log_level: LogLevel::Info,
            log_to_file: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DebugEvent {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub event: String,
    pub source: LogSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subsystem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DebugBackendStatus {
    pub config: DebugConfig,
    pub session_id: String,
    pub buffered: usize,
    pub dropped: u64,
    pub pending: usize,
    pub file_bytes: u64,
    pub file_error: Option<String>,
    pub watcher_running: bool,
    pub index_ready: bool,
    pub vault_open: bool,
}

enum WriterMessage {
    Event(String),
    Clear(mpsc::SyncSender<Result<(), String>>),
    Flush(mpsc::SyncSender<Result<(), String>>),
}

struct RuntimeState {
    config: DebugConfig,
    entries: VecDeque<DebugEvent>,
    dropped: u64,
    file_error: Option<String>,
    app: Option<tauri::AppHandle>,
    seen_events: HashMap<String, DebugEvent>,
    seen_order: VecDeque<String>,
}

/// Isolated diagnostics runtime. Each test owns a runtime instance; production
/// uses one process-wide instance shared by the Tauri state and tracing layer.
pub struct DebugRuntime {
    session_id: String,
    state: Mutex<RuntimeState>,
    sender: SyncSender<WriterMessage>,
    pending: Arc<std::sync::atomic::AtomicUsize>,
    file_path: Arc<Mutex<Option<PathBuf>>>,
    writer_status: Arc<Mutex<Option<String>>>,
    linearization: Mutex<()>,
    controls_global_filter: std::sync::atomic::AtomicBool,
    next_sequence: std::sync::atomic::AtomicU64,
}

#[derive(Clone)]
pub struct DebugState(pub Arc<DebugRuntime>);

pub struct OperationGuard {
    operation_id: Option<String>,
    event_prefix: &'static str,
    note_id: String,
    started: Instant,
    complete: bool,
}

impl OperationGuard {
    pub fn begin(
        event_prefix: &'static str,
        operation_id: Option<String>,
        note_id: String,
    ) -> Self {
        let guard = Self {
            operation_id,
            event_prefix,
            note_id,
            started: Instant::now(),
            complete: false,
        };
        guard.record("started", None);
        guard
    }
    pub fn succeed(mut self) {
        self.complete = true;
        self.record("succeeded", None);
    }
    pub fn operation_id(&self) -> Option<&str> {
        self.operation_id.as_deref()
    }
    fn record(&self, phase: &str, error_code: Option<&str>) {
        let mut metadata = Map::new();
        metadata.insert("noteId".to_owned(), Value::String(self.note_id.clone()));
        metadata.insert(
            "outcome".to_owned(),
            Value::String(
                if phase == "failed" {
                    "failed"
                } else if phase == "succeeded" {
                    "success"
                } else {
                    "started"
                }
                .to_owned(),
            ),
        );
        if let Some(code) = error_code {
            metadata.insert("errorCode".to_owned(), Value::String(code.to_owned()));
        }
        let event = DebugEvent {
            id: ulid::Ulid::generate().to_string(),
            timestamp: chrono_timestamp(),
            level: if phase == "failed" {
                LogLevel::Error
            } else {
                LogLevel::Info
            },
            event: format!("{}.{}", self.event_prefix, phase),
            source: LogSource::Backend,
            metadata: Some(metadata),
            session_id: None,
            window_id: None,
            operation_id: self.operation_id.clone(),
            subsystem: Some("notes".to_owned()),
            duration_ms: if phase == "started" {
                None
            } else {
                Some(self.started.elapsed().as_secs_f64() * 1_000.0)
            },
            sequence: None,
        };
        let _ = global_runtime().ingest(event);
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if !self.complete {
            self.record("failed", Some("OperationFailed"));
        }
    }
}

static GLOBAL: OnceLock<Arc<DebugRuntime>> = OnceLock::new();
static FILTER_RELOAD: OnceLock<
    Mutex<
        Option<
            tracing_subscriber::reload::Handle<
                tracing_subscriber::EnvFilter,
                tracing_subscriber::Registry,
            >,
        >,
    >,
> = OnceLock::new();

fn safe_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "FileNotFound",
        std::io::ErrorKind::PermissionDenied => "PermissionDenied",
        std::io::ErrorKind::AlreadyExists => "AlreadyExists",
        std::io::ErrorKind::InvalidData => "InvalidData",
        std::io::ErrorKind::WriteZero => "WriteZero",
        std::io::ErrorKind::TimedOut => "TimedOut",
        _ => "IoError",
    }
    .to_owned()
}

fn writer_loop(
    receiver: Receiver<WriterMessage>,
    pending: Arc<std::sync::atomic::AtomicUsize>,
    path: Arc<Mutex<Option<PathBuf>>>,
    status: Arc<Mutex<Option<String>>>,
) {
    let mut file: Option<File> = None;
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Event(line) => {
                let result = append_line(&mut file, &path, &line);
                pending.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                if let Err(error) = result {
                    if let Ok(mut slot) = status.lock() {
                        *slot = Some(error);
                    }
                } else if let Ok(mut slot) = status.lock() {
                    *slot = None;
                }
            }
            WriterMessage::Flush(reply) => {
                let result = file
                    .as_mut()
                    .map_or(Ok(()), |f| f.flush().map_err(|e| safe_error(&e)))
                    .and_then(|_| {
                        status
                            .lock()
                            .map_err(|_| "LockPoisoned".to_owned())?
                            .clone()
                            .map_or(Ok(()), Err)
                    });
                let _ = reply.send(result);
            }
            WriterMessage::Clear(reply) => {
                file = None;
                let result = clear_files(&path);
                if let Ok(mut slot) = status.lock() {
                    *slot = result.as_ref().err().cloned();
                }
                let _ = reply.send(result);
            }
        }
    }
}

fn append_line(
    file: &mut Option<File>,
    path: &Arc<Mutex<Option<PathBuf>>>,
    line: &str,
) -> Result<(), String> {
    let configured = path.lock().map_err(|_| "LockPoisoned".to_owned())?.clone();
    let Some(path) = configured else {
        return Err("LogPathUnavailable".to_owned());
    };
    let current_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if current_len.saturating_add(line.len() as u64 + 1) > FILE_LIMIT {
        *file = None;
        rotate_files(&path)?;
    }
    if file.is_none() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| safe_error(&e))?;
        }
        *file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| safe_error(&e))?,
        );
    }
    let file = file.as_mut().expect("opened above");
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| safe_error(&e))
}

fn rotate_files(path: &Path) -> Result<(), String> {
    let first = archive_path(path, 1);
    let second = archive_path(path, 2);
    if second.exists() {
        fs::remove_file(&second).map_err(|e| safe_error(&e))?;
    }
    if first.exists() {
        fs::rename(&first, &second).map_err(|e| safe_error(&e))?;
    }
    if path.exists() {
        fs::rename(path, &first).map_err(|e| safe_error(&e))?;
    }
    Ok(())
}

fn archive_path(path: &Path, number: usize) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{number}"));
    path.with_file_name(name)
}

fn clear_files(path: &Arc<Mutex<Option<PathBuf>>>) -> Result<(), String> {
    let path = path.lock().map_err(|_| "LockPoisoned".to_owned())?.clone();
    let Some(path) = path else {
        return Ok(());
    };
    let legacy_log = path.with_file_name("amby.log");
    let legacy_archive = path.with_file_name("amby.old.log");
    for candidate in [
        &path,
        &archive_path(&path, 1),
        &archive_path(&path, 2),
        &legacy_log,
        &legacy_archive,
    ] {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(safe_error(&error)),
        }
    }
    Ok(())
}

impl DebugRuntime {
    pub fn new() -> Arc<Self> {
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let file_path = Arc::new(Mutex::new(None));
        let writer_status = Arc::new(Mutex::new(None));
        let (sender, receiver) = mpsc::sync_channel(QUEUE_LIMIT);
        let worker_pending = Arc::clone(&pending);
        let worker_path = Arc::clone(&file_path);
        let worker_status = Arc::clone(&writer_status);
        thread::Builder::new()
            .name("amby-debug-writer".to_owned())
            .spawn(move || writer_loop(receiver, worker_pending, worker_path, worker_status))
            .expect("spawn diagnostics writer");
        Arc::new(Self {
            session_id: ulid::Ulid::generate().to_string(),
            state: Mutex::new(RuntimeState {
                config: DebugConfig::default(),
                entries: VecDeque::with_capacity(MEMORY_LIMIT),
                dropped: 0,
                file_error: None,
                app: None,
                seen_events: HashMap::new(),
                seen_order: VecDeque::new(),
            }),
            sender,
            pending,
            file_path,
            writer_status,
            linearization: Mutex::new(()),
            controls_global_filter: std::sync::atomic::AtomicBool::new(false),
            next_sequence: std::sync::atomic::AtomicU64::new(1),
        })
    }

    pub fn configure_path(&self, path: PathBuf) -> Result<(), String> {
        *self
            .file_path
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())? = Some(path);
        Ok(())
    }

    pub fn set_app(&self, app: tauri::AppHandle) {
        if let Ok(mut state) = self.state.lock() {
            state.app = Some(app);
        }
    }

    pub fn set_file_error(&self, error: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.file_error = Some(error.into());
        }
    }

    pub fn configure(&self, config: DebugConfig) -> Result<DebugBackendStatus, String> {
        let _linearization = self
            .linearization
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?;
        let previous_file_config = self
            .state
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?
            .config
            .log_to_file;
        if previous_file_config && !config.log_to_file {
            let _ = self.barrier(false);
        }
        if self
            .controls_global_filter
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            update_filter(config.enabled, config.log_level)?;
        }
        if let Ok(mut state) = self.state.lock() {
            state.config = config;
        }
        self.status(false, false, false)
    }

    pub fn is_recordable(&self, level: LogLevel) -> bool {
        self.state
            .lock()
            .map(|s| level.rank() >= effective_minimum(&s.config).rank())
            .unwrap_or(false)
    }

    pub fn ingest(&self, mut event: DebugEvent) -> Result<DebugEvent, String> {
        let _linearization = self
            .linearization
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?;
        if event.source == LogSource::Backend {
            event.session_id = Some(self.session_id.clone());
        }
        event.sequence = None;
        sanitize_event(&mut event, &self.session_id);
        let config = self
            .state
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?
            .config
            .clone();
        if event.level.rank() < effective_minimum(&config).rank() {
            return Ok(event);
        }
        let mut state = self.state.lock().map_err(|_| "LockPoisoned".to_owned())?;
        if let Some(previous) = state.seen_events.get(&event.id) {
            return Ok(previous.clone());
        }
        event.sequence = Some(
            self.next_sequence
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        );
        let serialized = serde_json::to_string(&event).map_err(|_| "SerializeFailed".to_owned())?;
        if state.entries.len() >= MEMORY_LIMIT {
            state.entries.pop_front();
            state.dropped = state.dropped.saturating_add(1);
        }
        state.entries.push_back(event.clone());
        state.seen_order.push_back(event.id.clone());
        state.seen_events.insert(event.id.clone(), event.clone());
        while state.seen_order.len() > HISTORY_LIMIT {
            if let Some(expired) = state.seen_order.pop_front() {
                state.seen_events.remove(&expired);
            }
        }
        if config.log_to_file {
            self.pending
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if self
                .sender
                .try_send(WriterMessage::Event(serialized))
                .is_err()
            {
                self.pending
                    .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                state.dropped = state.dropped.saturating_add(1);
                state.file_error = Some("QueueFull".to_owned());
            }
        }
        let app = state.app.clone();
        drop(state);
        if let Some(app) = app {
            let _ = app.emit("amby:debug-event", &event);
        }
        Ok(event)
    }

    pub fn recent(&self) -> Vec<DebugEvent> {
        self.state
            .lock()
            .map(|s| s.entries.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn history(&self) -> Result<Vec<DebugEvent>, String> {
        self.barrier(false)?;
        let path = self
            .file_path
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?
            .clone();
        let Some(path) = path else {
            return Ok(Vec::new());
        };
        let mut events: VecDeque<DebugEvent> = VecDeque::with_capacity(HISTORY_LIMIT);
        let mut seen = HashMap::<String, ()>::new();
        for candidate in [archive_path(&path, 2), archive_path(&path, 1), path] {
            let mut file = match File::open(&candidate) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(safe_error(&error)),
            };
            let length = file.metadata().map_err(|error| safe_error(&error))?.len();
            if length > FILE_LIMIT {
                file.seek(SeekFrom::Start(length - FILE_LIMIT))
                    .map_err(|error| safe_error(&error))?;
            }
            let mut reader = BufReader::new(file.take(FILE_LIMIT));
            if length > FILE_LIMIT {
                let mut discarded = Vec::new();
                reader
                    .read_until(b'\n', &mut discarded)
                    .map_err(|error| safe_error(&error))?;
            }
            let mut line = Vec::new();
            loop {
                line.clear();
                let bytes = reader
                    .read_until(b'\n', &mut line)
                    .map_err(|error| safe_error(&error))?;
                if bytes == 0 {
                    break;
                }
                if line.len() > MAX_EVENT_BYTES {
                    continue;
                }
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if let Ok(serialized) = std::str::from_utf8(&line) {
                    if let Ok(mut event) = serde_json::from_str::<DebugEvent>(serialized) {
                        if seen.insert(event.id.clone(), ()).is_some() {
                            continue;
                        }
                        sanitize_event(&mut event, &self.session_id);
                        if events.len() >= HISTORY_LIMIT {
                            if let Some(expired) = events.pop_front() {
                                seen.remove(&expired.id);
                            }
                        }
                        events.push_back(event);
                    }
                }
            }
        }
        Ok(events.into_iter().collect())
    }

    pub fn clear(&self) -> Result<(), String> {
        let _linearization = self
            .linearization
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?;
        let mut state = self.state.lock().map_err(|_| "LockPoisoned".to_owned())?;
        self.barrier(true)?;
        state.entries.clear();
        state.seen_events.clear();
        state.seen_order.clear();
        state.dropped = 0;
        state.file_error = None;
        if let Some(app) = &state.app {
            let _ = app.emit("amby:debug-cleared", ());
        }
        Ok(())
    }

    pub fn barrier(&self, clear: bool) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.sender.send_timeout_message(
            if clear {
                WriterMessage::Clear(tx)
            } else {
                WriterMessage::Flush(tx)
            },
            BARRIER_TIMEOUT,
        )?;
        rx.recv_timeout(BARRIER_TIMEOUT)
            .map_err(|_| "FlushTimedOut".to_owned())??;
        if !clear {
            if let Some(error) = self
                .state
                .lock()
                .map_err(|_| "LockPoisoned".to_owned())?
                .file_error
                .clone()
            {
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn status(
        &self,
        watcher_running: bool,
        index_ready: bool,
        vault_open: bool,
    ) -> Result<DebugBackendStatus, String> {
        let state = self.state.lock().map_err(|_| "LockPoisoned".to_owned())?;
        let file_bytes = self
            .file_path
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?
            .as_ref()
            .map(|path| {
                [path, &archive_path(path, 1), &archive_path(path, 2)]
                    .into_iter()
                    .filter_map(|candidate| fs::metadata(candidate).ok())
                    .map(|metadata| metadata.len())
                    .sum()
            })
            .unwrap_or(0);
        let file_error = self
            .writer_status
            .lock()
            .map_err(|_| "LockPoisoned".to_owned())?
            .clone()
            .or_else(|| state.file_error.clone());
        Ok(DebugBackendStatus {
            config: state.config.clone(),
            session_id: self.session_id.clone(),
            buffered: state.entries.len(),
            dropped: state.dropped,
            pending: self.pending.load(std::sync::atomic::Ordering::Relaxed),
            file_bytes,
            file_error,
            watcher_running,
            index_ready,
            vault_open,
        })
    }
}

// std::sync::mpsc has no stable send_timeout method on SyncSender; use bounded
// try_send with a deadline so diagnostic flush cannot block window shutdown.
trait BoundedSend {
    fn send_timeout_message(&self, message: WriterMessage, timeout: Duration)
        -> Result<(), String>;
}
impl BoundedSend for SyncSender<WriterMessage> {
    fn send_timeout_message(
        &self,
        message: WriterMessage,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = std::time::Instant::now() + timeout;
        let mut message = Some(message);
        loop {
            match self.try_send(message.take().expect("message retained until sent")) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err("WriterUnavailable".to_owned())
                }
                Err(mpsc::TrySendError::Full(returned)) => {
                    message = Some(returned);
                    if std::time::Instant::now() >= deadline {
                        return Err("WriterBusy".to_owned());
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

fn effective_minimum(config: &DebugConfig) -> LogLevel {
    if config.enabled {
        config.log_level
    } else if config.log_level.rank() < LogLevel::Info.rank() {
        LogLevel::Info
    } else {
        config.log_level
    }
}

fn update_filter(enabled: bool, level: LogLevel) -> Result<(), String> {
    let filter = if enabled {
        level.tracing_filter()
    } else {
        "info"
    };
    if let Some(slot) = FILTER_RELOAD.get() {
        if let Some(handle) = slot.lock().map_err(|_| "LockPoisoned".to_owned())?.as_ref() {
            handle
                .reload(tracing_subscriber::EnvFilter::new(filter))
                .map_err(|_| "FilterUpdateFailed".to_owned())?;
        }
    }
    Ok(())
}

pub fn global_runtime() -> Arc<DebugRuntime> {
    Arc::clone(GLOBAL.get_or_init(|| {
        let runtime = DebugRuntime::new();
        runtime
            .controls_global_filter
            .store(true, std::sync::atomic::Ordering::Relaxed);
        runtime
    }))
}

pub fn init_logging() {
    let runtime = global_runtime();
    let (filter_layer, handle) =
        tracing_subscriber::reload::Layer::new(tracing_subscriber::EnvFilter::new("info"));
    if let Ok(mut slot) = FILTER_RELOAD.get_or_init(|| Mutex::new(None)).lock() {
        *slot = Some(handle);
    }
    let subscriber = tracing_subscriber::registry()
        .with(filter_layer)
        .with(DiagnosticsLayer(runtime));
    let _ = subscriber.try_init();
}

struct DiagnosticsLayer(Arc<DebugRuntime>);
#[derive(Clone)]
struct CorrelationContext {
    operation_id: String,
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for DiagnosticsLayer
where
    S: for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        let mut visitor = FieldVisitor::default();
        attrs.record(&mut visitor);
        if let Some(operation_id) = visitor.values.get("operation_id").and_then(Value::as_str) {
            if let Some(span) = ctx.span(id) {
                span.extensions_mut().insert(CorrelationContext {
                    operation_id: operation_id.to_owned(),
                });
            }
        }
    }

    fn on_record(
        &self,
        id: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        ctx: Context<'_, S>,
    ) {
        let mut visitor = FieldVisitor::default();
        values.record(&mut visitor);
        if let Some(operation_id) = visitor.values.get("operation_id").and_then(Value::as_str) {
            if !operation_id.is_empty() {
                if let Some(span) = ctx.span(id) {
                    span.extensions_mut().insert(CorrelationContext {
                        operation_id: operation_id.to_owned(),
                    });
                }
            }
        }
    }

    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let metadata = event.metadata();
        let mut fields = visitor.values;
        let target = metadata.target().replace("::", ".");
        let event_name = fields
            .remove("event")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| target.clone());
        let operation_id = fields
            .remove("operation_id")
            .and_then(|value| value.as_str().map(str::to_owned))
            .or_else(|| {
                ctx.lookup_current().and_then(|span| {
                    let extensions = span.extensions();
                    extensions
                        .get::<CorrelationContext>()
                        .map(|context| context.operation_id.clone())
                })
            });
        let level = match *metadata.level() {
            tracing::Level::ERROR => LogLevel::Error,
            tracing::Level::WARN => LogLevel::Warn,
            tracing::Level::INFO => LogLevel::Info,
            _ => LogLevel::Debug,
        };
        let metadata = sanitize_metadata(fields, &self.0.session_id);
        let entry = DebugEvent {
            id: ulid::Ulid::generate().to_string(),
            timestamp: chrono_timestamp(),
            level,
            event: event_name,
            source: LogSource::Backend,
            metadata: Some(metadata),
            session_id: Some(self.0.session_id.clone()),
            window_id: None,
            operation_id,
            subsystem: Some(safe_subsystem(&target)),
            duration_ms: None,
            sequence: None,
        };
        if let Ok(event) = self.0.ingest(entry) {
            if let Ok(json) = serde_json::to_string(&event) {
                let _ = writeln!(std::io::stdout().lock(), "{json}");
            }
        }
    }
}

#[derive(Default)]
struct FieldVisitor {
    values: Map<String, Value>,
}
impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.values
            .insert(field.name().to_owned(), Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.values
            .insert(field.name().to_owned(), Value::String(value.to_owned()));
    }
    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.values
            .insert(field.name().to_owned(), Value::Number(value.into()));
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.values
            .insert(field.name().to_owned(), Value::Number(value.into()));
    }
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.values
            .insert(field.name().to_owned(), Value::Bool(value));
    }
    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        if let Some(number) = Number::from_f64(value) {
            self.values
                .insert(field.name().to_owned(), Value::Number(number));
        }
    }
}

fn sanitize_event(event: &mut DebugEvent, session: &str) {
    if !safe_event_id(&event.id) {
        event.id = ulid::Ulid::generate().to_string();
    }
    if !valid_timestamp(&event.timestamp) {
        event.timestamp = "unknown".to_owned();
    }
    let effective_session = event
        .session_id
        .as_deref()
        .and_then(safe_opaque_id)
        .unwrap_or_else(|| session.to_owned());
    if !allowed_event(&event.event) {
        event.event = "diagnostic.invalid_event".to_owned();
    }
    event.subsystem = event
        .subsystem
        .as_deref()
        .filter(|subsystem| allowed_subsystem(subsystem))
        .map(str::to_owned);
    event.metadata = event
        .metadata
        .take()
        .map(|metadata| sanitize_metadata(metadata, &effective_session));
    event.duration_ms = event
        .duration_ms
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 86_400_000.0);
    event.operation_id = event.operation_id.as_deref().and_then(safe_opaque_id);
    event.window_id = event.window_id.as_deref().and_then(safe_opaque_id);
    event.session_id = Some(effective_session);
}

fn allowed_event(value: &str) -> bool {
    const ALLOWED_EVENTS: &[&str] = &[
        "app_starting",
        "apply_database_value_batch",
        "autosave.error_dialog_failed",
        "autosave.failed",
        "autosave.queue",
        "autosave.rejected_document_mismatch",
        "autosave.save.started",
        "autosave.start",
        "autosave.success",
        "canvas.save_failed",
        "change_database_property_type",
        "create_database_property",
        "create_database_row",
        "create_folder",
        "create_note",
        "note.read",
        "note.write",
        "database.aggregate",
        "database.change_property_type",
        "database.change_property_type_failed",
        "database.commit_cell",
        "database.commit_cell_failed",
        "database.create_property",
        "database.create_property_failed",
        "database.create_relation_row",
        "database.create_relation_row_failed",
        "database.create_row",
        "database.create_row_failed",
        "database.create_view",
        "database.delete_property",
        "database.delete_property_failed",
        "database.delete_view",
        "database.duplicate_view",
        "database.mutate_view_failed",
        "database.projection_rebuild_failed",
        "database.query",
        "database.rebuild",
        "database.refresh",
        "database.rename_property",
        "database.rename_property_failed",
        "database.rename_view",
        "database.row_index_update_failed",
        "database.set_default_view",
        "database.sync_yaml",
        "database.update_view_config",
        "database.view_action_failed",
        "database_projection_rebuild_failed",
        "database_row_index_update_failed",
        "debug.invalid_event",
        "debug.invalid_subsystem",
        "delete_custom_property",
        "delete_database_property",
        "delete_item",
        "deleted_note_restore_index_failed",
        "diagnostic.invalid_event",
        "diagnostic.legacy_event",
        "diagnostic.legacy_line",
        "doc.load",
        "document.restore_deleted_failed",
        "editor.toggle_lock",
        "editor.view_mode",
        "external_conflict.keep_local_failed",
        "external_conflict.save_copy_failed",
        "file.attach_canvas",
        "file.attach_canvas_failed",
        "file.attach_sketch",
        "file.attach_sketch_failed",
        "file.create_canvas",
        "file.create_canvas_failed",
        "file.create_folder",
        "file.create_folder_failed",
        "file.create_note",
        "file.create_note_failed",
        "file.create_sketch",
        "file.create_sketch_failed",
        "file.delete",
        "file.move",
        "file.move_failed",
        "file.rename",
        "file.rename_failed",
        "file.set_icon",
        "file.toggle_favorite",
        "frontend_started",
        "history.operation_failed",
        "index.load",
        "index.rebuild",
        "index.refresh",
        "index_update_failed",
        "layer.switch",
        "manual_save.failed",
        "media_drop.import_failed",
        "note_saved",
        "note_write_event_failed",
        "note_written.listen_failed",
        "note_written.open_document_reload_failed",
        "property.delete",
        "property.reorder",
        "property.upsert",
        "read_note",
        "read_note.failed",
        "read_note.started",
        "read_note.succeeded",
        "refresh_vault.database_sync_failed",
        "refresh_vault.failed",
        "refresh_vault.flush_failed",
        "rename_database_property",
        "rename_item",
        "reorder_custom_properties",
        "reorder_database_properties",
        "restore_window_failed",
        "restored_note_tree_event_failed",
        "session.document_load_failed",
        "search.notes",
        "settings.credential_migration_failed",
        "settings.save_failed",
        "sketch.save_failed",
        "sketch_render_error",
        "startup.failure",
        "startup.error",
        "startup_error",
        "startup_failure",
        "storage.apply_database_value_batch",
        "storage.archive_item",
        "storage.attach_canvas",
        "storage.attach_sketch",
        "storage.change_database_property_type",
        "storage.create_canvas",
        "storage.create_database",
        "storage.create_database_property",
        "storage.create_database_row",
        "storage.create_database_view",
        "storage.create_folder",
        "storage.create_note",
        "storage.create_sketch",
        "storage.delete_custom_property",
        "storage.delete_database_property",
        "storage.delete_database_view",
        "storage.delete_item",
        "storage.move_item",
        "storage.read_file",
        "storage.read_note",
        "storage.rename_database_property",
        "storage.rename_database_view",
        "storage.rename_item",
        "storage.reorder_custom_properties",
        "storage.reorder_database_properties",
        "storage.write_file",
        "storage.write_note",
        "storage.update_database_relation_value",
        "storage.upsert_custom_property",
        "tab.close",
        "tab.close_all",
        "tab.open_item",
        "tab.open_singleton",
        "tab.switch",
        "tab.toggle_split",
        "tree.activate_tab",
        "tree.open_file",
        "tree.select",
        "unhandled_promise_rejection",
        "unhandled_window_error",
        "updater.automatic_update_failed",
        "updater.version_read_failed",
        "upsert_custom_property",
        "vault_switch.activation_failed",
        "vault_switch.autosave_flush_failed",
        "vault_switch.broadcast_failed",
        "vault_switch.broadcast_listen_failed",
        "vault_switch.error_dialog_failed",
        "vault_tree.reload_failed",
        "visibilitychange.autosave_flush_failed",
        "watcher.event_received",
        "watcher.external_change_callback_failed",
        "watcher.listen_failed",
        "watcher.open_document_reload_failed",
        "watcher.process",
        "watcher.refresh_failed",
        "watcher.start",
        "watcher.start_failed",
        "watcher.stop",
        "watcher.stop_failed",
        "window_close.autosave_flush_failed",
        "window_close.autosave_recovery_retained",
        "window_close.failed",
        "window_close.listen_failed",
        "window_state.flush_failed",
        "window_state.read_size_failed",
        "window_state.resize_listen_failed",
        "window_state.restore_failed",
        "window_state.save_failed",
        "write_note",
        "write_note.failed",
        "write_note.started",
        "write_note.succeeded",
    ];
    if ALLOWED_EVENTS.contains(&value) {
        return true;
    }
    let Some((base, suffix)) = value.rsplit_once('.') else {
        return false;
    };
    let allowed_base = matches!(
        base,
        "note.read"
            | "note.write"
            | "read_note"
            | "write_note"
            | "database.aggregate"
            | "database.query"
            | "database.rebuild"
            | "database.refresh"
            | "database.sync_yaml"
            | "index.load"
            | "index.rebuild"
            | "index.refresh"
            | "search.notes"
            | "storage.read_file"
            | "storage.read_note"
            | "storage.write_file"
            | "watcher.process"
            | "watcher.start"
            | "watcher.stop"
    );
    allowed_base && matches!(suffix, "started" | "completed" | "succeeded" | "failed")
}

fn sanitize_metadata(input: Map<String, Value>, session: &str) -> Map<String, Value> {
    let mut output = Map::new();
    for (key, value) in input.into_iter().take(48) {
        if identity_key(&key) {
            if let Some(value) = value.as_str() {
                output.insert(key, Value::String(pseudonym(value, session)));
            }
        } else if numeric_key(&key) {
            if value.as_bool().is_some()
                || value
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.abs() <= 1_000_000_000_000.0)
            {
                output.insert(key, value);
            }
        } else if code_key(&key) {
            if let Some(value) = value.as_str() {
                if let Some(value) = safe_code(value, &key) {
                    output.insert(key, Value::String(value));
                }
            }
        }
    }
    output
}

fn identity_key(key: &str) -> bool {
    matches!(
        key,
        "noteId"
            | "note_id"
            | "documentId"
            | "document_id"
            | "databaseId"
            | "database_id"
            | "propertyId"
            | "property_id"
            | "path"
            | "fileId"
            | "file_id"
            | "resourceId"
    )
}
fn numeric_key(key: &str) -> bool {
    matches!(
        key,
        "count"
            | "changed_paths"
            | "containers"
            | "durationMs"
            | "bytes"
            | "buffered"
            | "dropped"
            | "pending"
            | "size"
            | "attempt"
            | "generation"
            | "sequence"
            | "rows"
            | "columns"
            | "files"
            | "queueWaitMs"
            | "executionMs"
            | "latencyMs"
            | "retryCount"
            | "total"
            | "remaining"
            | "limit"
            | "fileBytes"
            | "eventCount"
            | "dirtyCount"
            | "openCount"
            | "participants"
            | "scheduled"
            | "inFlight"
            | "paused"
            | "errors"
            | "active"
            | "enabled"
            | "requiresFullRebuild"
            | "healthy"
            | "isRetryable"
    )
}
fn code_key(key: &str) -> bool {
    matches!(
        key,
        "errorCode" | "errorType" | "code" | "kind" | "reason" | "outcome" | "state" | "status"
    )
}
fn safe_code(value: &str, key: &str) -> Option<String> {
    let allowed = match key {
        "errorCode" => matches!(
            value,
            "UnknownError"
                | "FileNotFound"
                | "PermissionDenied"
                | "AlreadyExists"
                | "InvalidData"
                | "WriteZero"
                | "TimedOut"
                | "IoError"
                | "QueueFull"
                | "WriterUnavailable"
                | "FlushTimedOut"
                | "LockPoisoned"
                | "OperationFailed"
        ),
        "errorType" => matches!(
            value,
            "Error" | "TypeError" | "RangeError" | "IoError" | "UnknownError"
        ),
        "outcome" | "status" => matches!(
            value,
            "started" | "success" | "failed" | "warning" | "error" | "ok"
        ),
        "state" => matches!(
            value,
            "healthy" | "degraded" | "rebuildRequired" | "staleReadOnly" | "unknown"
        ),
        "kind" | "code" | "reason" => matches!(
            value,
            "create"
                | "modify"
                | "remove"
                | "rename"
                | "write"
                | "delete"
                | "timeout"
                | "conflict"
                | "cancelled"
                | "unknown"
        ),
        _ => false,
    };
    if allowed {
        Some(value.to_owned())
    } else if matches!(key, "errorCode" | "errorType") {
        Some("UnknownError".to_owned())
    } else {
        None
    }
}
fn safe_subsystem(value: &str) -> String {
    let normalized = value.replace("::", ".");
    let Some(module_path) = normalized.strip_prefix("amby_notes.") else {
        return "backend".to_owned();
    };
    let mut segments = module_path.split('.');
    let Some(first) = segments.next() else {
        return "backend".to_owned();
    };
    let module = if first == "commands" {
        segments.next().unwrap_or("backend")
    } else {
        first
    };
    match module {
        "notes" | "database" | "mutations" | "vault" | "state" | "modules" | "assets" | "debug"
        | "watcher" | "history" | "logging" => module.to_owned(),
        _ => "backend".to_owned(),
    }
}
fn allowed_subsystem(value: &str) -> bool {
    matches!(
        value,
        "backend"
            | "notes"
            | "database"
            | "mutations"
            | "vault"
            | "state"
            | "modules"
            | "note_written"
            | "assets"
            | "debug"
            | "watcher"
            | "history"
            | "logging"
            | "autosave"
            | "startup"
            | "storage"
            | "index"
            | "search"
            | "file"
            | "doc"
            | "tree"
            | "editor"
            | "property"
            | "tab"
            | "layer"
            | "canvas"
            | "sketch"
            | "settings"
            | "updater"
            | "vault_switch"
            | "vault_tree"
            | "window_close"
            | "window_state"
            | "visibilitychange"
            | "external_conflict"
            | "media_drop"
            | "session"
            | "refresh_vault"
            | "diagnostics"
            | "ai"
    )
}
fn safe_event_id(value: &str) -> bool {
    is_ulid(value)
        || is_uuid(value)
        || prefixed_uuid(value, "evt_")
        || (value.len() >= 17
            && value.len() <= 20
            && value.split_once('-').is_some_and(|(time, random)| {
                time.len() >= 10
                    && time.len() <= 13
                    && time.bytes().all(|b| b.is_ascii_digit())
                    && random.len() == 6
                    && random
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            }))
}
fn safe_opaque_id(value: &str) -> Option<String> {
    if is_ulid(value)
        || is_uuid(value)
        || prefixed_uuid(value, "fe_")
        || prefixed_uuid(value, "op_")
        || prefixed_uuid(value, "win_")
        || matches!(value, "main" | "settings" | "splash")
        || (value.len() == 19
            && value.starts_with("id_")
            && value[3..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
    {
        Some(value.to_owned())
    } else {
        None
    }
}
fn prefixed_uuid(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(is_uuid)
}
fn is_ulid(value: &str) -> bool {
    value.len() == 26 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z'))
}
fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| [4, 7, 10, 13, 16, 19, 23].contains(&i) || b.is_ascii_digit())
}
fn pseudonym(value: &str, session: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    session.hash(&mut hasher);
    value.hash(&mut hasher);
    if value.len() == 19
        && value.starts_with("id_")
        && value[3..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        value.to_owned()
    } else {
        format!("id_{:016x}", hasher.finish())
    }
}
fn chrono_timestamp() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3_600,
        (day_seconds / 60) % 60,
        day_seconds % 60,
        duration.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(level: LogLevel) -> DebugEvent {
        DebugEvent { id: "1700000000000-abc123".into(), timestamp: "2026-09-27T00:00:00.000Z".into(), level, event: "note_saved".into(), source: LogSource::Frontend, metadata: Some(serde_json::json!({"path":"/Users/alice/Vault/Secret.md", "count":3, "error":"disk /private/path"}).as_object().unwrap().clone()), session_id: Some("fe_550e8400-e29b-41d4-a716-446655440000".into()), window_id: Some("main".into()), operation_id: Some("op_550e8400-e29b-41d4-a716-446655440000".into()), subsystem: Some("storage".into()), duration_ms: Some(12.0), sequence: None }
    }

    #[test]
    fn sanitizes_before_buffer_and_keeps_frontend_ids() {
        let runtime = DebugRuntime::new();
        runtime.ingest(sample(LogLevel::Error)).unwrap();
        let event = runtime.recent().pop().unwrap();
        assert_eq!(event.id, "1700000000000-abc123");
        assert!(event.operation_id.as_deref().unwrap().starts_with("op_"));
        assert!(event.session_id.as_deref().unwrap().starts_with("fe_"));
        let metadata = event.metadata.unwrap();
        assert!(metadata["path"].as_str().unwrap().starts_with("id_"));
        assert_eq!(metadata.get("error"), None);
        assert_eq!(metadata["count"], 3);
    }

    #[test]
    fn below_threshold_return_is_sanitized_and_private_codes_are_rejected() {
        let runtime = DebugRuntime::new();
        let mut event = sample(LogLevel::Debug);
        event
            .metadata
            .as_mut()
            .unwrap()
            .insert("errorCode".into(), Value::String("secretErrorToken".into()));
        event
            .metadata
            .as_mut()
            .unwrap()
            .insert("title".into(), Value::String("Private title".into()));
        let returned = runtime.ingest(event).unwrap();
        assert_eq!(returned.id, "1700000000000-abc123");
        let metadata = returned.metadata.unwrap();
        assert_eq!(metadata.get("title"), None);
        assert_eq!(metadata["errorCode"], "UnknownError");
        assert_eq!(runtime.recent().len(), 0);
    }

    #[test]
    fn sanitizes_untrusted_alphanumeric_event_and_subsystem_labels() {
        let runtime = DebugRuntime::new();
        let mut event = sample(LogLevel::Error);
        event.event = "secret_customer_note".into();
        event.subsystem = Some("secret_customer_workspace".into());

        let returned = runtime.ingest(event).unwrap();
        assert_eq!(returned.event, "diagnostic.invalid_event");
        assert_eq!(returned.subsystem, None);
        let stored = runtime.recent().pop().unwrap();
        assert_eq!(stored.event, "diagnostic.invalid_event");
        assert_eq!(stored.subsystem, None);
    }

    #[test]
    fn timestamps_are_iso8601_and_malformed_identifiers_are_discarded() {
        let timestamp = chrono_timestamp();
        assert!(valid_timestamp(&timestamp));
        let runtime = DebugRuntime::new();
        let mut event = sample(LogLevel::Error);
        event.id = "private/path?token=x".into();
        event.operation_id = Some("secret-operation".into());
        event.session_id = Some("private-session".into());
        runtime.ingest(event).unwrap();
        let saved = runtime.recent().pop().unwrap();
        assert!(is_ulid(&saved.id));
        assert_eq!(saved.operation_id, None);
        assert_eq!(
            saved.session_id.as_deref(),
            Some(runtime.session_id.as_str())
        );
    }

    #[test]
    fn duplicate_ids_are_acknowledged_without_duplicate_buffer_or_file_records() {
        let temp =
            std::env::temp_dir().join(format!("amby-debug-dedup-{}", ulid::Ulid::generate()));
        let path = temp.join("amby.jsonl");
        let runtime = DebugRuntime::new();
        runtime.configure_path(path.clone()).unwrap();
        runtime
            .configure(DebugConfig {
                enabled: true,
                log_level: LogLevel::Debug,
                log_to_file: true,
            })
            .unwrap();
        let first = runtime.ingest(sample(LogLevel::Info)).unwrap();
        let mut retry = sample(LogLevel::Info);
        retry
            .metadata
            .as_mut()
            .unwrap()
            .insert("count".into(), Value::from(999));
        let ack = runtime.ingest(retry).unwrap();
        runtime.barrier(false).unwrap();
        assert_eq!(first.sequence, ack.sequence);
        assert_eq!(runtime.recent().len(), 1);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 1);
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn config_controls_runtime_threshold_and_disk_opt_in() {
        let runtime = DebugRuntime::new();
        runtime
            .configure(DebugConfig {
                enabled: false,
                log_level: LogLevel::Debug,
                log_to_file: false,
            })
            .unwrap();
        runtime.ingest(sample(LogLevel::Debug)).unwrap();
        assert!(runtime.recent().is_empty());
        runtime.ingest(sample(LogLevel::Info)).unwrap();
        assert_eq!(runtime.recent().len(), 1);
    }

    #[test]
    fn barrier_clear_removes_ring_and_files() {
        let temp = std::env::temp_dir().join(format!("amby-debug-{}", ulid::Ulid::generate()));
        let runtime = DebugRuntime::new();
        runtime.configure_path(temp.join("amby.jsonl")).unwrap();
        runtime
            .configure(DebugConfig {
                enabled: true,
                log_level: LogLevel::Debug,
                log_to_file: true,
            })
            .unwrap();
        runtime.ingest(sample(LogLevel::Info)).unwrap();
        runtime.barrier(false).unwrap();
        assert!(temp.join("amby.jsonl").exists());
        runtime.clear().unwrap();
        assert!(runtime.recent().is_empty());
        assert!(!temp.join("amby.jsonl").exists());
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn retained_history_survives_runtime_restart_with_session_identity() {
        let temp =
            std::env::temp_dir().join(format!("amby-debug-history-{}", ulid::Ulid::generate()));
        let path = temp.join("amby.jsonl");
        let first = DebugRuntime::new();
        first.configure_path(path.clone()).unwrap();
        first
            .configure(DebugConfig {
                enabled: true,
                log_level: LogLevel::Debug,
                log_to_file: true,
            })
            .unwrap();
        first.ingest(sample(LogLevel::Info)).unwrap();
        first.barrier(false).unwrap();

        let second = DebugRuntime::new();
        second.configure_path(path).unwrap();
        let history = second.history().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "1700000000000-abc123");
        assert_eq!(
            history[0].session_id.as_deref(),
            Some("fe_550e8400-e29b-41d4-a716-446655440000")
        );
        assert!(history[0].metadata.as_ref().unwrap()["path"]
            .as_str()
            .unwrap()
            .starts_with("id_"));
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn history_reads_bounded_tail_and_skips_oversized_partial_records() {
        let temp =
            std::env::temp_dir().join(format!("amby-debug-bounded-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&temp).unwrap();
        let path = temp.join("amby.jsonl");
        let mut bytes = vec![b'x'; FILE_LIMIT as usize + 1024];
        bytes.push(b'\n');
        bytes.extend_from_slice(
            serde_json::to_string(&sample(LogLevel::Info))
                .unwrap()
                .as_bytes(),
        );
        bytes.push(b'\n');
        fs::write(&path, bytes).unwrap();
        let runtime = DebugRuntime::new();
        runtime.configure_path(path).unwrap();
        let history = runtime.history().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].event, "note_saved");
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn writer_failure_is_reported_without_exposing_path() {
        let temp =
            std::env::temp_dir().join(format!("amby-debug-failure-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&temp).unwrap();
        let blocker = temp.join("not-a-directory");
        fs::write(&blocker, "x").unwrap();
        let runtime = DebugRuntime::new();
        runtime.configure_path(blocker.join("amby.jsonl")).unwrap();
        runtime
            .configure(DebugConfig {
                enabled: true,
                log_level: LogLevel::Debug,
                log_to_file: true,
            })
            .unwrap();
        runtime.ingest(sample(LogLevel::Info)).unwrap();
        assert!(runtime.barrier(false).is_err());
        let status = runtime.status(false, false, false).unwrap();
        assert!(status.file_error.is_some());
        assert!(!status
            .file_error
            .unwrap()
            .contains(temp.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn rotation_keeps_only_the_configured_archive_depth() {
        let temp =
            std::env::temp_dir().join(format!("amby-debug-rotate-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&temp).unwrap();
        let path = temp.join("amby.jsonl");
        fs::write(&path, vec![b'x'; FILE_LIMIT as usize]).unwrap();
        fs::write(archive_path(&path, 1), "previous one").unwrap();
        fs::write(archive_path(&path, 2), "previous two").unwrap();
        let runtime = DebugRuntime::new();
        runtime.configure_path(path.clone()).unwrap();
        runtime
            .configure(DebugConfig {
                enabled: true,
                log_level: LogLevel::Debug,
                log_to_file: true,
            })
            .unwrap();
        runtime.ingest(sample(LogLevel::Info)).unwrap();
        runtime.barrier(false).unwrap();
        assert_eq!(
            fs::read_to_string(archive_path(&path, 2)).unwrap(),
            "previous one"
        );
        assert!(fs::read_to_string(&path).unwrap().contains("note_saved"));
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn ingestion_and_clear_are_linearizable_under_concurrency() {
        let runtime = DebugRuntime::new();
        runtime
            .configure(DebugConfig {
                enabled: true,
                log_level: LogLevel::Debug,
                log_to_file: false,
            })
            .unwrap();
        let writer_runtime = Arc::clone(&runtime);
        let writer = thread::spawn(move || {
            for _ in 0..500 {
                writer_runtime.ingest(sample(LogLevel::Info)).unwrap();
            }
        });
        runtime.clear().unwrap();
        writer.join().unwrap();
        let entries = runtime.recent();
        assert!(entries.len() <= MEMORY_LIMIT);
        assert!(entries.iter().all(|entry| entry
            .metadata
            .as_ref()
            .is_some_and(|m| m.get("error").is_none())));
    }
}
