import {
  commands,
  type McpClient,
  type McpClientError,
  type McpClientStatus,
  type Result,
} from "../bindings"
export type { McpClient, McpClientStatus }

/** A failed connection of an AI client; the code is turned into text by the interface. */
export class McpClientOperationError extends Error {
  constructor(readonly code: McpClientError) {
    super(code)
    this.name = "McpClientOperationError"
  }
}

/** Connecting the open vault to Claude Code, Codex or Cursor as an MCP server. Absent in the browser. */
export interface McpClientsPort {
  available: boolean
  status(): Promise<McpClientStatus[]>
  connect(client: McpClient, vault: string, write: boolean): Promise<McpClientStatus>
  disconnect(client: McpClient): Promise<McpClientStatus>
}

async function call<T>(request: Promise<Result<T, McpClientError>>): Promise<T> {
  let result: Result<T, McpClientError>
  try {
    result = await request
  } catch {
    throw new McpClientOperationError("failed")
  }
  if (result.status === "ok") return result.data
  throw new McpClientOperationError(result.error)
}

const unavailable = async (): Promise<never> => {
  throw new McpClientOperationError("failed")
}

export function createMcpClientsPort(native: boolean): McpClientsPort {
  if (!native)
    return { available: false, status: unavailable, connect: unavailable, disconnect: unavailable }
  return {
    available: true,
    status: () => call(commands.mcpClientsStatus()),
    connect: (client, vault, write) => call(commands.mcpClientConnect(client, vault, write)),
    disconnect: (client) => call(commands.mcpClientDisconnect(client)),
  }
}
