import { commands, type CliPathError, type CliPathStatus, type Result } from "../bindings"
export type { CliPathStatus }

/** A failed change of the `amby` command; the code is turned into text by the interface. */
export class CliPathOperationError extends Error {
  constructor(readonly code: CliPathError) {
    super(code)
    this.name = "CliPathOperationError"
  }
}

/** Putting the bundled `amby` command on PATH (Settings → General). Absent in the browser. */
export interface CliPathPort {
  available: boolean
  status(): Promise<CliPathStatus>
  install(): Promise<CliPathStatus>
  remove(): Promise<CliPathStatus>
}

async function call(request: Promise<Result<CliPathStatus, CliPathError>>): Promise<CliPathStatus> {
  let result: Result<CliPathStatus, CliPathError>
  try {
    result = await request
  } catch {
    throw new CliPathOperationError("failed")
  }
  if (result.status === "ok") return result.data
  throw new CliPathOperationError(result.error)
}

const unavailable = async (): Promise<never> => {
  throw new CliPathOperationError("unavailable")
}

export function createCliPathPort(native: boolean): CliPathPort {
  if (!native)
    return { available: false, status: unavailable, install: unavailable, remove: unavailable }
  return {
    available: true,
    status: () => call(commands.cliPathStatus()),
    install: () => call(commands.cliPathInstall()),
    remove: () => call(commands.cliPathRemove()),
  }
}
