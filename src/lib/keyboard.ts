/**
 * Keyboard helpers shared by our own DOM/React key handlers.
 *
 * Enter that confirms an IME composition (Chinese/Japanese/Korean, macOS accent
 * or dictation input) must not trigger rename/save/send/confirm. Chromium marks
 * such a keydown with `isComposing`; Safari/WebKit (WKWebView on macOS) fires the
 * final keydown with `isComposing === false` but `keyCode === 229`. Check both.
 * Always use `isEnterKey` instead of comparing `event.key` with "Enter".
 */

type KeyLike = Pick<KeyboardEvent, "key"> & {
  keyCode?: number
  isComposing?: boolean
  /** Present on React synthetic events. */
  nativeEvent?: { isComposing?: boolean }
}

export function isComposingKeyEvent(event: KeyLike): boolean {
  return (
    event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229
  )
}

/** True for a real Enter press, not the Enter that commits an IME composition. */
export function isEnterKey(event: KeyLike): boolean {
  return event.key === "Enter" && !isComposingKeyEvent(event)
}
