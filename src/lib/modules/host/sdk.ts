import type React from "react"
import type { ModuleManifest, ModulePermission } from "../types"
import type { PanelDef, ActionDef } from "@/components/workspace/panel-registry"

export const AMBY_SDK_VERSION = "0.1.0"

export interface ModuleHostContext {
  moduleId: string
  vault: string | null
  isSafeMode: boolean
}

export class SecurityPermissionError extends Error {
  constructor(
    public readonly permission: ModulePermission,
    public readonly moduleId: string,
  ) {
    super(`Permission denied: Module "${moduleId}" does not have "${permission}" permission.`)
    this.name = "SecurityPermissionError"
  }
}

export interface FileHandlerDefinition {
  extension: string
  moduleId: string
  viewKind: string
  openDocument?: (path: string, ctx: ModuleHostContext) => void
  renderFallback?: (path: string) => React.ReactNode
}

export interface BackgroundTaskHandle {
  id: string
  moduleId: string
  stop: () => void | Promise<void>
}

export interface ExtensionApi {
  context: ModuleHostContext
  hasPermission: (permission: ModulePermission) => boolean
  requirePermission: (permission: ModulePermission) => void

  // Vault file operations (confined to current vault, guarded by vault.read / vault.write)
  readFile: (relPath: string) => Promise<string>
  writeFile: (relPath: string, contents: string) => Promise<void>

  // Contribution registries
  files: {
    register: (handler: FileHandlerDefinition) => () => void
  }
  panels: {
    register: (panel: PanelDef) => () => void
  }
  commands: {
    register: (action: ActionDef) => () => void
  }
  tasks: {
    register: (task: BackgroundTaskHandle) => () => void
  }
}

export interface ModuleDefinition {
  manifest: ModuleManifest
  activate: (api: ExtensionApi) => void | Promise<void>
  deactivate?: () => void | Promise<void>
  dispose?: () => void | Promise<void>
}
