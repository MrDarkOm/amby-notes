//! SAVE-04: Quit from the Dock menu (and `tell application to quit`) on macOS.
//!
//! These reach the process as `[NSApp terminate:]` without any close request, and tao implements
//! only `applicationWillTerminate:` (no `applicationShouldTerminate:`), so neither `RunEvent::
//! ExitRequested` nor a window close handler runs before the process ends. The macOS hook below
//! adds `applicationShouldTerminate:` to tao's application delegate. It never answers
//! `NSTerminateLater` (checked natively: AppKit's terminate-later loop does not run tao's
//! main-thread work, so the app hung). Instead a normal quit is cancelled, the windows are asked to
//! close through their save handlers on the ordinary event loop (as Cmd+Q does), and the app exits
//! when the last one is gone, or after a timeout. Logout, restart and shutdown are never held.

use std::sync::Mutex;

/// How long the windows get to save before the app exits anyway. Recovery drafts (written within
/// about a second of typing, and flushed first by every window's close handler) keep the text in
/// any case.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Flushing,
    Releasing,
}

/// What `applicationShouldTerminate:` must do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Step {
    /// Answer `NSTerminateNow`: the process ends as it would without the hook.
    Allow,
    /// Answer `NSTerminateCancel` and start the flush (once): close the windows through their
    /// save handlers on the event loop, exit after `FLUSH_TIMEOUT` if still running.
    CancelAndFlush,
    /// Answer `NSTerminateCancel`: a flush is already running.
    Cancel,
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

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl TerminateGate {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(State::Idle),
        }
    }

    /// A termination request arrived. `system` is a logout / restart / shutdown; `has_editing_window`
    /// says whether any window could hold unsaved edits.
    pub fn request(&self, system: bool, has_editing_window: bool) -> Step {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match *state {
            State::Releasing => Step::Allow,
            State::Flushing if system => Step::Allow,
            State::Flushing => Step::Cancel,
            State::Idle if system || !has_editing_window => Step::Allow,
            State::Idle => {
                *state = State::Flushing;
                Step::CancelAndFlush
            }
        }
    }

    /// The flush timeout ran out. True when this call moved a running flush to "releasing", so the
    /// caller must exit the app now; false when the app is already ending or no flush ran.
    pub fn timeout(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let held = *state == State::Flushing;
        if held {
            *state = State::Releasing;
        }
        held
    }

    /// The app is ending on its own: any later terminate goes straight through.
    pub fn release(&self) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = State::Releasing;
    }
}

/// Whether a `keyAEQuitReason` value is a logout, restart or shutdown (`kAELogOut` 'logo',
/// `kAEReallyLogOut` 'rlgo', `kAEShowRestartDialog` 'rrst', `kAERestart` 'rest',
/// `kAEShowShutdownDialog` 'rsdn', `kAEShutDown` 'shut').
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_system_quit_reason(code: u32) -> bool {
    [b"logo", b"rlgo", b"rrst", b"rest", b"rsdn", b"shut"]
        .iter()
        .any(|c| u32::from_be_bytes(**c) == code)
}

/// The process is ending on its own (the last window is gone): later terminates need no hold.
pub fn note_exiting() {
    #[cfg(target_os = "macos")]
    macos::GATE.release();
}

/// Install the hook once the application delegate exists (`RunEvent::Ready`).
pub fn install<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    macos::install(handle);
    #[cfg(not(target_os = "macos"))]
    let _ = handle;
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{is_system_quit_reason, Step, TerminateGate, FLUSH_TIMEOUT};
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    use std::sync::OnceLock;

    pub static GATE: TerminateGate = TerminateGate::new();

    struct Hooks {
        /// Whether any window could hold unsaved edits.
        has_editing_window: Box<dyn Fn() -> bool + Send + Sync>,
        /// Close the editing windows through their save handlers, on the event loop (never inside
        /// the delegate call).
        flush: Box<dyn Fn() + Send + Sync>,
        /// Exit the app through the normal loop.
        exit: Box<dyn Fn() + Send + Sync>,
    }

    static HOOKS: OnceLock<Hooks> = OnceLock::new();

    const NSTERMINATE_CANCEL: usize = 0;
    const NSTERMINATE_NOW: usize = 1;

    /// `keyAEQuitReason` ('why?') of the Apple Event being handled, 0 when there is none.
    fn current_quit_reason() -> u32 {
        const KEY_AE_QUIT_REASON: u32 = u32::from_be_bytes(*b"why?");
        let Some(class) = AnyClass::get(c"NSAppleEventManager") else {
            return 0;
        };
        // SAFETY: plain Foundation getters called on the main thread; every object pointer is
        // checked for nil before it is messaged, and `enumCodeValue` returns an `OSType` (u32).
        unsafe {
            let manager: *mut AnyObject = msg_send![class, sharedAppleEventManager];
            if manager.is_null() {
                return 0;
            }
            let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
            if event.is_null() {
                return 0;
            }
            let mut reason: *mut AnyObject =
                msg_send![event, attributeDescriptorForKeyword: KEY_AE_QUIT_REASON];
            if reason.is_null() {
                reason = msg_send![event, paramDescriptorForKeyword: KEY_AE_QUIT_REASON];
            }
            if reason.is_null() {
                return 0;
            }
            msg_send![reason, enumCodeValue]
        }
    }

    extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let Some(hooks) = HOOKS.get() else {
            return NSTERMINATE_NOW;
        };
        let system = is_system_quit_reason(current_quit_reason());
        match GATE.request(system, (hooks.has_editing_window)()) {
            Step::Allow => NSTERMINATE_NOW,
            Step::Cancel => NSTERMINATE_CANCEL,
            Step::CancelAndFlush => {
                tracing::info!(event = "terminate_cancelled_for_flush");
                // Off this call: the flush runs on the ordinary event loop once the delegate returns.
                std::thread::spawn(|| {
                    if let Some(hooks) = HOOKS.get() {
                        (hooks.flush)();
                    }
                    std::thread::sleep(FLUSH_TIMEOUT);
                    if GATE.timeout() {
                        tracing::warn!(event = "terminate_flush_timeout");
                        if let Some(hooks) = HOOKS.get() {
                            (hooks.exit)();
                        }
                    }
                });
                NSTERMINATE_CANCEL
            }
        }
    }

    pub fn install<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
        if HOOKS.get().is_some() {
            return;
        }
        let windows = handle.clone();
        let flush = handle.clone();
        let exit = handle.clone();
        let hooks = Hooks {
            has_editing_window: Box::new(move || {
                use tauri::Manager;
                let open = windows.webview_windows();
                crate::state::quit_plan(open.keys().map(String::as_str))
                    != crate::state::QuitPlan::Exit
            }),
            flush: Box::new(move || {
                let inner = flush.clone();
                let _ = flush.run_on_main_thread(move || crate::state::request_quit(&inner));
            }),
            exit: Box::new(move || exit.exit(0)),
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
    use super::{is_system_quit_reason, Step, TerminateGate};

    #[test]
    fn a_normal_quit_with_an_editing_window_is_cancelled_and_flushed() {
        assert_eq!(
            TerminateGate::new().request(false, true),
            Step::CancelAndFlush
        );
    }

    #[test]
    fn logout_restart_and_shutdown_are_never_held() {
        for code in [b"logo", b"rlgo", b"rrst", b"rest", b"rsdn", b"shut"] {
            assert!(is_system_quit_reason(u32::from_be_bytes(*code)));
        }
        assert!(!is_system_quit_reason(0));
        assert!(!is_system_quit_reason(u32::from_be_bytes(*b"quit")));
        let gate = TerminateGate::new();
        assert_eq!(gate.request(true, true), Step::Allow);
        // A system quit does not start a flush, so a later normal quit still can.
        assert_eq!(gate.request(false, true), Step::CancelAndFlush);
    }

    #[test]
    fn a_system_quit_during_a_flush_goes_through() {
        let gate = TerminateGate::new();
        gate.request(false, true);
        assert_eq!(gate.request(true, true), Step::Allow);
    }

    #[test]
    fn no_editing_window_ends_the_process_at_once() {
        let gate = TerminateGate::new();
        assert_eq!(gate.request(false, false), Step::Allow);
        assert!(!gate.timeout());
    }

    #[test]
    fn a_second_request_during_the_flush_cancels_without_a_second_flush() {
        let gate = TerminateGate::new();
        assert_eq!(gate.request(false, true), Step::CancelAndFlush);
        assert_eq!(gate.request(false, true), Step::Cancel);
        assert_eq!(gate.request(false, true), Step::Cancel);
    }

    #[test]
    fn the_timeout_exits_once_and_lets_the_process_end() {
        let gate = TerminateGate::new();
        gate.request(false, true);
        assert!(gate.timeout());
        assert!(!gate.timeout());
        assert_eq!(gate.request(false, true), Step::Allow);
    }

    #[test]
    fn a_finished_flush_makes_the_late_timeout_a_no_op() {
        let gate = TerminateGate::new();
        gate.request(false, true);
        gate.release();
        assert!(!gate.timeout());
        assert_eq!(gate.request(false, true), Step::Allow);
    }

    #[test]
    fn a_stray_timeout_without_a_flush_does_nothing() {
        let gate = TerminateGate::new();
        assert!(!gate.timeout());
        assert_eq!(gate.request(false, true), Step::CancelAndFlush);
    }

    #[test]
    fn the_timeout_is_a_few_seconds() {
        assert!(super::FLUSH_TIMEOUT.as_secs() >= 2 && super::FLUSH_TIMEOUT.as_secs() <= 10);
    }
}
