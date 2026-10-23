//! The clock of the application (Р12: the engine reaches time only through [`Clock`]). It is
//! used for marks in lists (when a conflict appeared), never for a decision (Р3, С10).

use amby_sync_core::engine::Clock;

/// Wall-clock time of the system.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
}
