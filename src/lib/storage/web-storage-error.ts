import i18n from "@/lib/i18n"

export type WebStorageErrorCode = "quotaExceeded" | "unavailable"

/** Localizable, detail-free browser storage failure. */
export class WebStorageError extends Error {
  readonly code: WebStorageErrorCode

  constructor(code: WebStorageErrorCode) {
    super(
      i18n.t(
        code === "quotaExceeded" ? "errors.storageQuotaExceeded" : "errors.storageUnavailable",
      ),
    )
    this.name = "WebStorageError"
    this.code = code
  }
}

function toWebStorageError(error: unknown): WebStorageError {
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : ""
  return new WebStorageError(
    name === "QuotaExceededError" || /quota|storage full|disk full/iu.test(message)
      ? "quotaExceeded"
      : "unavailable",
  )
}

export function withWebStorage<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    throw toWebStorageError(error)
  }
}
