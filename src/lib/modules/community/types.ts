import type { ModuleManifest } from "../types"

export interface CommunityPluginManifest extends ModuleManifest {
  kind: "community"
  entry?: string
  networkAllowlist?: string[]
  csp?: string
}

export type SandboxRpcMethod =
  | "vault.readFile"
  | "vault.writeFile"
  | "network.fetch"
  | "clipboard.read"
  | "clipboard.write"
  | "workspace.notify"

export interface RpcRequest {
  id: string
  method: SandboxRpcMethod
  params: Record<string, unknown>
}

export interface RpcResponse<T = unknown> {
  id: string
  result?: T
  error?: {
    code: string
    message: string
  }
}

export interface RevocationEntry {
  moduleId: string
  versionPattern: string // "*" or specific semver like "1.0.0"
  reason: string
  revokedAt: string
}
