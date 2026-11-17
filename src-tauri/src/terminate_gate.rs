//! SAVE-04: Quit from the Dock menu and logout / shutdown on macOS.
//!
//! These reach the process as `[NSApp terminate:]` without any close request, and tao implements
//! only `applicationWillTerminate:` (no `applicationShouldTerminate:`), so neither `RunEvent::
//! ExitRequested` nor a window close handler runs before the process ends. The macOS hook below
//! adds `applicationShouldTerminate:` to tao's application delegate; this file's `TerminateGate`
//! is the state machine it drives.

use std::sync::Mutex;

/// How long the windows get to save before termination goes ahead anyway. Logout must not hang;
/// recovery drafts (written within about a second of typing, and flushed first by every window's
/// close handler) keep the text in any case.
pub const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Flushing,
    Allowed,
}

/// What a termination request must do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// First request: hold termination, ask the windows to save, start the timeout.
    HoldAndFlush,
    /// A request while the windows are still saving: keep holding.
    Hold,
    /// Let the process end now.
    Allow,
}

#[derive(Debug)]
pub struct TerminateGate {
    state: Mutex<State>,
}

impl Default for TerminateGate {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminateGate {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(State::Idle),
        }
    }

    /// A termination request arrived (Dock Quit, logout, shutdown).
    pub fn request(&self) -> Step {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match *state {
            State::Idle => {
                *state = State::Flushing;
                Step::HoldAndFlush
            }
            State::Flushing => Step::Hold,
            State::Allowed => Step::Allow,
        }
    }

    /// The windows saved (or the timeout ran out). True when this call moved a held termination to
    /// "allowed", so the caller must release it; false when nothing was held.
    pub fn finish(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let held = *state == State::Flushing;
        if held {
            *state = State::Allowed;
        }
        held
    }
}

/// The process is ending on its own (the last window is gone): a held termination needs no release.
pub fn note_exiting() {
    #[cfg(target_os = "macos")]
    macos::GATE.finish();
}

/// Install the hook once the application delegate exists (`RunEvent::Ready`). `ask_windows` closes
/// the editing windows through their save handlers, as the Cmd+Q item does.
pub fn install<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    macos::install(handle);
    #[cfg(not(target_os = "macos"))]
    let _ = handle;
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{Step, TerminateGate, FLUSH_TIMEOUT};
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    use std::sync::OnceLock;

    pub static GATE: TerminateGate = TerminateGate::new();

    struct Hooks {
        /// Ask the editing windows to close through their save handlers.
        ask_windows: Box<dyn Fn() + Send + Sync>,
        /// Answer the held `applicationShouldTerminate:` with "yes", on the main thread.
        release: Box<dyn Fn() + Send + Sync>,
    }

    static HOOKS: OnceLock<Hooks> = OnceLock::new();

    const NSTERMINATE_NOW: usize = 1;
    const NSTERMINATE_LATER: usize = 2;

    extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let Some(hooks) = HOOKS.get() else {
            return NSTERMINATE_NOW;
        };
        match GATE.request() {
            Step::Allow => NSTERMINATE_NOW,
            Step::Hold => NSTERMINATE_LATER,
            Step::HoldAndFlush => {
                tracing::info!(event = "terminate_flush_started");
                std::thread::spawn(|| {
                    std::thread::sleep(FLUSH_TIMEOUT);
                    if GATE.finish() {
                        tracing::warn!(event = "terminate_flush_timeout");
                        if let Some(hooks) = HOOKS.get() {
                            (hooks.release)();
                        }
                    }
                });
                (hooks.ask_windows)();
                NSTERMINATE_LATER
            }
        }
    }

    pub fn install<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
        if HOOKS.get().is_some() {
            return;
        }
        let ask = handle.clone();
        let release = handle.clone();
        let hooks = Hooks {
            ask_windows: Box::new(move || crate::state::request_quit(&ask)),
            release: Box::new(move || {
                let _ = release.run_on_main_thread(|| {
                    // SAFETY: `run_on_main_thread` runs this on the main thread.
                    let marker = unsafe { MainThreadMarker::new_unchecked() };
                    NSApplication::sharedApplication(marker)
                        .replyToApplicationShouldTerminate(true);
                });
            }),
        };
        if HOOKS.set(hooks).is_err() {
            return;
        }
        let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else {
            tracing::warn!(
                event = "terminate_hook_failed",
                reason = "no_delegate_class"
            );
            return;
        };
        // SAFETY: the signature matches `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)`
        // (`Q@:@`). tao implements no such method, so adding it cannot replace one.
        let added = unsafe {
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(should_terminate);
            class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            tracing::warn!(event = "terminate_hook_failed", reason = "method_not_added");
            return;
        }
        // AppKit may remember which delegate methods exist from the time the delegate was set.
        let marker = unsafe { MainThreadMarker::new_unchecked() };
        let app = NSApplication::sharedApplication(marker);
        unsafe {
            let delegate: *mut AnyObject = msg_send![&*app, delegate];
            let _: () = msg_send![&*app, setDelegate: delegate];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Step, TerminateGate};

    #[test]
    fn the_first_request_is_held_and_asks_the_windows_to_save() {
        let gate = TerminateGate::new();
        assert_eq!(gate.request(), Step::HoldAndFlush);
    }

    #[test]
    fn a_request_while_saving_stays_held_once() {
        let gate = TerminateGate::new();
        gate.request();
        assert_eq!(gate.request(), Step::Hold);
        // Several requests never start a second flush.
        assert_eq!(gate.request(), Step::Hold);
    }

    #[test]
    fn finishing_the_flush_allows_the_process_to_end() {
        let gate = TerminateGate::new();
        gate.request();
        assert!(gate.finish());
        assert_eq!(gate.request(), Step::Allow);
    }

    #[test]
    fn the_timeout_is_the_same_release_as_a_finished_flush_and_runs_once() {
        let gate = TerminateGate::new();
        gate.request();
        // The windows finished first; the late timeout finds nothing held.
        assert!(gate.finish());
        assert!(!gate.finish());
    }

    #[test]
    fn finishing_without_a_held_request_releases_nothing() {
        let gate = TerminateGate::new();
        assert!(!gate.finish());
        // The process is not marked allowed by a stray finish.
        assert_eq!(gate.request(), Step::HoldAndFlush);
    }

    #[test]
    fn the_timeout_is_a_few_seconds() {
        assert!(super::FLUSH_TIMEOUT.as_secs() >= 2 && super::FLUSH_TIMEOUT.as_secs() <= 10);
    }
}
