/**
 * Owns a disposer returned by an asynchronous native registration.
 *
 * React effects can be cleaned up before Tauri resolves `listen()` or a
 * window-event registration. In that case the disposer must be called as
 * soon as it becomes available, otherwise the native listener outlives the
 * effect that created it.
 */
export function adoptAsyncDisposer(
  registration: Promise<(() => void) | undefined>,
  onError?: (error: unknown) => void,
): () => void {
  let cancelled = false
  let dispose: (() => void) | undefined

  void registration
    .then((resolved) => {
      if (cancelled) {
        resolved?.()
      } else {
        dispose = resolved
      }
    })
    .catch((error) => onError?.(error))

  return () => {
    cancelled = true
    dispose?.()
    dispose = undefined
  }
}
