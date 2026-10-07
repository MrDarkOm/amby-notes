import * as React from "react"

/**
 * One operation ID per user intent. Repeating the same request (a retry after
 * a failure) reuses the ID, so Rust returns the recorded answer instead of a
 * second set; a changed request gets a new one, because Rust refuses to reuse
 * an ID for a different payload.
 */
export function useOperationId(prefix: string, payload: unknown): () => string {
  const key = JSON.stringify(payload)
  const current = React.useRef<{ key: string; id: string } | null>(null)
  return React.useCallback(() => {
    if (!current.current || current.current.key !== key) {
      current.current = { key, id: `${prefix}-${crypto.randomUUID()}` }
    }
    return current.current.id
  }, [key, prefix])
}
