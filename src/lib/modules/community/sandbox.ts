import { CapabilityBroker } from "../host/capability-broker"
import { SecurityPermissionError, type ModuleHostContext } from "../host/sdk"
import { quarantineManager } from "../host/safe-mode"
import { revocationRegistry } from "./revocation"
import type { CommunityPluginManifest, RpcRequest, RpcResponse } from "./types"
import { IsolatedPluginRuntime, type PluginExecutionResult } from "./isolated-runtime"

export interface SandboxExecutionOptions {
  manifest: CommunityPluginManifest
  context: ModuleHostContext
  onNotify?: (message: string) => void
}

export class CommunityPluginSandbox {
  private readonly broker: CapabilityBroker
  private readonly manifest: CommunityPluginManifest
  private readonly context: ModuleHostContext
  private isTerminated = false
  private runtime: IsolatedPluginRuntime | null = null

  constructor(private readonly options: SandboxExecutionOptions) {
    this.manifest = options.manifest
    this.context = options.context
    this.broker = new CapabilityBroker(options.manifest, options.context)
  }

  canActivate(): { allowed: boolean; reason?: string } {
    if (this.context.isSafeMode) {
      return { allowed: false, reason: "Safe mode is enabled: community plugins are disabled." }
    }

    if (revocationRegistry.isRevoked(this.manifest.id, this.manifest.version)) {
      const reason = revocationRegistry.getRevocationReason(this.manifest.id, this.manifest.version)
      return {
        allowed: false,
        reason: `Module "${this.manifest.id}" has been revoked: ${reason ?? "security concern"}`,
      }
    }

    if (quarantineManager.isQuarantined(this.manifest.id)) {
      return {
        allowed: false,
        reason: `Module "${this.manifest.id}" is quarantined due to repeated failures.`,
      }
    }

    return { allowed: true }
  }

  async handleRpcRequest(request: RpcRequest): Promise<RpcResponse> {
    if (this.isTerminated) {
      return {
        id: request.id,
        error: { code: "TERMINATED", message: "Plugin sandbox is terminated." },
      }
    }

    try {
      switch (request.method) {
        case "vault.readFile": {
          const relPath = request.params.relPath as string
          if (!relPath) throw new Error("Missing relPath parameter.")
          const content = await this.broker.readFile(relPath)
          return { id: request.id, result: content }
        }

        case "vault.writeFile": {
          const relPath = request.params.relPath as string
          const content = request.params.content as string
          if (!relPath || typeof content !== "string") {
            throw new Error("Missing relPath or content parameter.")
          }
          await this.broker.writeFile(relPath, content)
          return { id: request.id, result: { success: true } }
        }

        case "network.fetch": {
          this.broker.requirePermission("network")
          const urlStr = request.params.url as string
          if (!urlStr) throw new Error("Missing url parameter.")

          const parsedUrl = new URL(urlStr)
          const allowlist = this.manifest.networkAllowlist ?? []
          const isAllowed = allowlist.some((domain) => {
            if (domain === "*") return true
            return parsedUrl.hostname === domain || parsedUrl.hostname.endsWith(`.${domain}`)
          })

          if (!isAllowed) {
            throw new Error(
              `Network request to "${parsedUrl.hostname}" is not allowed. Allowed domains: ${allowlist.join(", ") || "none"}`,
            )
          }

          // In desktop/browser, perform fetch within bounds
          const response = await fetch(urlStr, {
            method: (request.params.method as string) || "GET",
            headers: (request.params.headers as Record<string, string>) || undefined,
            body: (request.params.body as string) || undefined,
          })
          const text = await response.text()
          return {
            id: request.id,
            result: {
              status: response.status,
              statusText: response.statusText,
              data: text,
            },
          }
        }

        case "clipboard.read": {
          this.broker.requirePermission("clipboard.read")
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            const text = await navigator.clipboard.readText()
            return { id: request.id, result: text }
          }
          throw new Error("Clipboard API is not available.")
        }

        case "clipboard.write": {
          this.broker.requirePermission("clipboard.write")
          const text = request.params.text as string
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(text ?? "")
            return { id: request.id, result: { success: true } }
          }
          throw new Error("Clipboard API is not available.")
        }

        case "workspace.notify": {
          const message = request.params.message as string
          if (this.options.onNotify) {
            this.options.onNotify(message)
          }
          return { id: request.id, result: { success: true } }
        }

        default:
          return {
            id: request.id,
            error: {
              code: "METHOD_NOT_FOUND",
              message: `Unknown RPC method: ${(request as { method: string }).method}`,
            },
          }
      }
    } catch (error) {
      if (error instanceof SecurityPermissionError) {
        return {
          id: request.id,
          error: {
            code: "PERMISSION_DENIED",
            message: error.message,
          },
        }
      }

      return {
        id: request.id,
        error: {
          code: "EXECUTION_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  async executeCode(code: string, timeoutMs = 5000): Promise<PluginExecutionResult> {
    const activation = this.canActivate()
    if (!activation.allowed) {
      return { success: false, error: activation.reason }
    }

    if (!this.runtime) {
      this.runtime = new IsolatedPluginRuntime()
      await this.runtime.init((req) => this.handleRpcRequest(req))
    }

    return this.runtime.executeCode(code, timeoutMs)
  }

  terminate(): void {
    this.isTerminated = true
    if (this.runtime) {
      this.runtime.terminate()
      this.runtime = null
    }
  }
}
