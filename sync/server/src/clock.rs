//! The clock interface (П37): the server never reads the system time directly, so that tests
//! can check 24 hours and 30 days without waiting.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A source of the current time in milliseconds since the Unix epoch, UTC (П37).
pub trait Clock: Send + Sync {
    /// The current time in milliseconds. It never decides which version is newer (Р3, С10).
    fn now_ms(&self) -> i64;
}

/// The real clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    /// П37: the system time.
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
}

/// A clock that only moves when it is told to (П37). For tests of retention and cleanup.
#[derive(Debug)]
pub struct ManualClock {
    now_ms: AtomicI64,
}

impl ManualClock {
    /// A clock that shows `now_ms`.
    pub fn new(now_ms: i64) -> Self {
        Self {
            now_ms: AtomicI64::new(now_ms),
        }
    }

    /// Moves the clock forward.
    pub fn advance(&self, by: Duration) {
        let by = i64::try_from(by.as_millis()).unwrap_or(i64::MAX);
        self.now_ms.fetch_add(by, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    /// П37: the time the test set.
    fn now_ms(&self) -> i64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}
