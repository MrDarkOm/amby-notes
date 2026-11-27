export type StorageOperationErrorCode =
  | "notFound"
  | "alreadyExists"
  | "permissionDenied"
  | "invalidPath"
  | "operationFailed"
  | "vaultBusy"
  | "vaultRecoveryRequired"
  | "undoItemMoved"
  | "undoNoteChanged"
  | "undoUnavailable"

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

/** The code a translated command sends (`StorageErrorCode` in the bindings). */
export function typedOperationError(error: {
  code:
    | "notFound"
    | "alreadyExists"
    | "permissionDenied"
    | "invalidPath"
    | "failed"
    | "undoItemMoved"
    | "undoNoteChanged"
    | "undoUnavailable"
  detail: string
}): StorageOperationError {
  return new StorageOperationError(
    error.code === "failed" ? "operationFailed" : error.code,
    error.detail,
  )
}

/**
 * Fallback for the commands that still send a bare sentence. Translated commands (`create_note`,
 * `create_folder`, `create_file`, `rename_item`, `move_item`, `delete_item`, `archive_item`) send
 * a typed `StorageError` and never reach this. The sentence carries the user's own paths, so it
 * is matched only at its two ends: the `(os error N)` the OS puts last, and a fixed head Amby
 * wrote before the first colon. A folder called "Collision" in the middle decides nothing.
 */
export function desktopOperationError(message: string): StorageOperationError {
  return new StorageOperationError(legacyCode(message), message)
}

function legacyCode(message: string): StorageOperationErrorCode {
  if (message === "vaultBusy") return "vaultBusy"
  if (message.startsWith("vaultRecoveryRequired: ")) return "vaultRecoveryRequired"
  // Rust io::Error includes a locale-independent OS code even on localized Windows.
  const os = /\(os error (\d+)\)\s*$/u.exec(message)?.[1]
  if (os === "2" || os === "3") return "notFound"
  if (os === "5" || os === "13") return "permissionDenied"
  if (os === "17" || os === "80" || os === "183") return "alreadyExists"
  const head = message.split(":")[0] ?? message
  if (head.split(" ").length > 4 || !/^[A-Za-z ]+$/u.test(head)) return "operationFailed"
  // "No such property" is the answer of the property commands for a name that is gone.
  if (/ already exists$/iu.test(head)) return "alreadyExists"
  if (/ not found$|^no such property$|does not exist$/iu.test(head)) return "notFound"
  if (
    /^(path escapes vault|path must be relative|unsafe relative path|invalid )|outside (the )?vault$/iu.test(
      head,
    )
  )
    return "invalidPath"
  return "operationFailed"
}
