//! Poison-tolerant locking.
//!
//! A `std::sync::Mutex` becomes "poisoned" when a thread panics while holding
//! it. Calling `.lock().unwrap()` then panics in every later command until the
//! app restarts, turning one bug into a permanently broken session.
//!
//! `lock_or_recover` takes the guard anyway, logs a warning once (the poison
//! flag is cleared afterwards) and carries on. It is only correct for mutexes
//! whose protected state cannot be left half-written in a harmful way. In this
//! app that holds for the vault mutexes:
//! - `mutation_gate` guards `()`; durable state lives in atomic file writes and
//!   SQLite transactions, which roll back when a panic unwinds;
//! - `conn` guards the SQLite handle and the vault root, replaced in one
//!   assignment;
//! - the watcher's self-write table and the index change queue are advisory:
//!   a lost entry costs at most a spurious reindex or conflict prompt.
//!
//! Recovery drafts and history snapshots are files, never kept in these
//! mutexes, so they are unaffected.

use std::panic::Location;
use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// Lock, recovering the guard if a previous holder panicked.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    #[track_caller]
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let caller = Location::caller();
                tracing::warn!(
                    file = caller.file(),
                    line = caller.line(),
                    "mutex was poisoned by an earlier panic; continuing with the recovered state"
                );
                self.clear_poison();
                poisoned.into_inner()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn poisoned(value: Vec<u8>) -> Arc<Mutex<Vec<u8>>> {
        let mutex = Arc::new(Mutex::new(value));
        let clone = Arc::clone(&mutex);
        let _ = std::thread::spawn(move || {
            let mut guard = clone.lock().unwrap();
            guard.push(2);
            panic!("poison the mutex");
        })
        .join();
        assert!(mutex.is_poisoned());
        mutex
    }

    #[test]
    fn recovers_the_value_written_before_the_panic() {
        let mutex = poisoned(vec![1]);
        assert_eq!(*mutex.lock_or_recover(), vec![1, 2]);
    }

    #[test]
    fn clears_the_poison_so_later_locks_are_plain() {
        let mutex = poisoned(Vec::new());
        drop(mutex.lock_or_recover());
        assert!(!mutex.is_poisoned());
        mutex.lock_or_recover().push(3);
        assert_eq!(*mutex.lock().unwrap(), vec![2, 3]);
    }

    #[test]
    fn healthy_mutex_behaves_like_lock() {
        let mutex = Mutex::new(5);
        *mutex.lock_or_recover() += 1;
        assert_eq!(*mutex.lock_or_recover(), 6);
    }
}
