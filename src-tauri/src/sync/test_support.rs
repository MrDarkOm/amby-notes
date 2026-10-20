//! Helpers for the sync tests: key store and connection record in memory (the system key store
//! is not touched by tests), a server in the process, and a capture of what is logged.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use amby_sync_conformance::Target;
use tracing_subscriber::fmt::MakeWriter;

use crate::sync::connection::{ConnectionError, ConnectionRecord, ConnectionStore};
use crate::sync::secrets::{SecretError, SecretStore};
use crate::sync::service::SyncService;
use crate::sync::types::Endpoint;

/// The key store in memory. `fail` makes every call fail (a locked or missing keychain).
#[derive(Default)]
pub struct MemorySecrets {
    map: Mutex<HashMap<String, String>>,
    pub fail: AtomicBool,
    /// Only `set` fails (the keychain refuses to write).
    pub fail_set: AtomicBool,
}

impl SecretStore for MemorySecrets {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(SecretError);
        }
        Ok(self.map.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        if self.fail.load(Ordering::SeqCst) || self.fail_set.load(Ordering::SeqCst) {
            return Err(SecretError);
        }
        self.map
            .lock()
            .unwrap()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(SecretError);
        }
        self.map.lock().unwrap().remove(name);
        Ok(())
    }
}

impl MemorySecrets {
    /// How many entries the store holds (for "nothing is stored").
    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    /// A value without the failure switches (for the assertions of tests).
    pub fn peek(&self, name: &str) -> Option<String> {
        self.map.lock().unwrap().get(name).cloned()
    }
}

/// The connection record in memory. `fail_save` makes writing fail.
#[derive(Default)]
pub struct MemoryConnection {
    record: Mutex<Option<ConnectionRecord>>,
    pub fail_save: AtomicBool,
}

impl ConnectionStore for MemoryConnection {
    fn load(&self) -> Result<Option<ConnectionRecord>, ConnectionError> {
        Ok(self.record.lock().unwrap().clone())
    }

    fn save(&self, record: &ConnectionRecord) -> Result<(), ConnectionError> {
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(ConnectionError);
        }
        *self.record.lock().unwrap() = Some(record.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), ConnectionError> {
        *self.record.lock().unwrap() = None;
        Ok(())
    }
}

/// One installation of the application: a service with its own key store and record.
pub struct Device {
    pub service: SyncService,
    pub secrets: Arc<MemorySecrets>,
    pub connection: Arc<MemoryConnection>,
}

impl Device {
    /// A device that is not signed in.
    pub fn new() -> Self {
        let secrets = Arc::new(MemorySecrets::default());
        let connection = Arc::new(MemoryConnection::default());
        Self {
            service: SyncService::new(secrets.clone(), connection.clone()),
            secrets,
            connection,
        }
    }

    /// The same installation after a restart of the application: new service, same stores.
    pub fn restarted(&self) -> SyncService {
        SyncService::new(self.secrets.clone(), self.connection.clone())
    }
}

/// The address of the server under test; "local network" is on so that the tests also run
/// against a container.
pub fn endpoint_of(target: &Target) -> Endpoint {
    Endpoint {
        url: target.api.base().to_string(),
        allow_http: true,
    }
}

/// A writer that collects everything the `tracing` subscriber prints.
#[derive(Clone, Default)]
pub struct LogCapture(pub Arc<Mutex<Vec<u8>>>);

impl LogCapture {
    /// Everything captured so far.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }

    /// A subscriber that prints every event of every crate, down to TRACE, into this capture.
    pub fn dispatch(&self) -> tracing::Dispatch {
        tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(self.clone())
                .finish(),
        )
    }
}

impl std::io::Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogCapture {
    type Writer = LogCapture;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}
