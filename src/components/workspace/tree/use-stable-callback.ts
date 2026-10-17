import * as React from "react"

type AnyFunction = (...args: never[]) => unknown

/**
 * A function whose identity never changes but which always calls the latest `fn`.
 * Rows of the tree are memoized; the workspace recreates its handlers on every render, so
 * passing them through unchanged re-rendered every visible row on each tab switch.
 * An absent handler stays absent, because rows show or hide actions by its presence.
 */
export function useStableCallback<F extends AnyFunction>(fn: F): F
export function useStableCallback<F extends AnyFunction>(fn: F | undefined): F | undefined
export function useStableCallback<F extends AnyFunction>(fn: F | undefined): F | undefined {
  const latest = React.useRef(fn)
  React.useLayoutEffect(() => {
    latest.current = fn
  })
  const stable = React.useCallback(
    (...args: Parameters<F>) =>
      (latest.current as ((...a: Parameters<F>) => ReturnType<F>) | undefined)?.(...args),
    [],
  ) as unknown as F
  return fn ? stable : undefined
}
