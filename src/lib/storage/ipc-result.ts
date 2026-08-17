import type { Result } from "@/lib/bindings"

/** Convert the generated Specta `Result` union into the Promise contract used
 * by storage callers. Transport exceptions are deliberately left untouched. */
export function unwrapCommandResult<T>(result: Result<T, string>): T {
  if (result.status === "ok") return result.data
  throw new Error(result.error)
}

export async function unwrapCommand<T>(command: Promise<Result<unknown, string>>): Promise<T> {
  return unwrapCommandResult(await command) as T
}
