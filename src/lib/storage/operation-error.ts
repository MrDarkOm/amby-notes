export type StorageOperationErrorCode =
  "notFound" | "alreadyExists" | "invalidPath" | "operationFailed"

/** Stable adapter-boundary category; the original diagnostic stays available. */
export class StorageOperationError extends Error {
  constructor(
    readonly code: StorageOperationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "StorageOperationError"
  }
}

export function desktopOperationError(message: string): StorageOperationError {
  // Rust io::Error includes a locale-independent OS code even on localized
  // Windows. Domain errors below originate in Amby's vault/path guards.
  const code: StorageOperationErrorCode = /not found|does not exist|os error [23]\)/iu.test(message)
    ? "notFound"
    : /already exists|collision|os error (80|183)\)/iu.test(message)
      ? "alreadyExists"
      : /escapes vault|must be relative|invalid.*(path|name)|outside.*vault/iu.test(message)
        ? "invalidPath"
        : "operationFailed"
  return new StorageOperationError(code, message)
}
