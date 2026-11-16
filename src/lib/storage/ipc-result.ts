import type { Result, StorageError } from "@/lib/bindings"
import { desktopOperationError, typedOperationError } from "./operation-error"

/** Convert the generated Specta `Result` union into the Promise contract used
 * by storage callers. Transport exceptions are deliberately left untouched.
 * A command that sends a typed `StorageError` gives its category by code; a bare
 * string goes through the anchored fallback in `operation-error.ts`. */
export function unwrapCommandResult<T>(result: Result<T, string | StorageError>): T {
  if (result.status === "ok") return result.data
  throw typeof result.error === "string"
    ? desktopOperationError(result.error)
    : typedOperationError(result.error)
}

export async function unwrapCommand<T>(
  command: Promise<Result<unknown, string | StorageError>>,
): Promise<T> {
  return unwrapCommandResult(await command) as T
}
