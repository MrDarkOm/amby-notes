//! SYNC-04: the batch of incoming changes must end even when applying a change panics. The app keeps
//! running after a panic of a pass, and a batch left open held every later watcher event: open
//! notes no longer learned about outside edits until a restart.

use amby_sync_core::engine::ports::end_batch_after;
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};

#[test]
fn the_batch_ends_after_a_normal_result() {
    let ended = Cell::new(false);
    let value = end_batch_after(Ok::<_, Box<dyn std::any::Any + Send>>(7), || {
        ended.set(true)
    });
    assert_eq!(value, 7);
    assert!(ended.get());
}

#[test]
fn the_batch_ends_and_the_panic_goes_on_when_applying_panicked() {
    let ended = Cell::new(false);
    let work = catch_unwind(|| -> u8 { panic!("a bug in apply") });
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        end_batch_after(work, || ended.set(true))
    }));
    assert!(ended.get(), "the batch must end before the panic goes on");
    assert!(outcome.is_err(), "the panic must still reach the session");
}
