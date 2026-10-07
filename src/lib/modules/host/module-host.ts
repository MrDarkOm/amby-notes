import { isTauri } from "@/lib/storage"
import { commands } from "@/lib/bindings"
import { logger } from "@/lib/logger"
import { canExecuteInstalledModules } from "./execution-policy"
import { toCanonicalModuleId } from "../types"
import { CapabilityBroker } from "./capability-broker"
import {
  CommandContributionRegistry,
  FileHandlerRegistry,
  PanelContributionRegistry,
  TaskContributionRegistry,
} from "./registries"
import { QuarantineManager, SafeModeState, quarantineManager, safeModeState } from "./safe-mode"
import type { ExtensionApi, ModuleDefinition, ModuleHostContext } from "./sdk"

export interface ModuleHostOptions {
  files?: FileHandlerRegistry
  panels?: PanelContributionRegistry
  commands?: CommandContributionRegistry
  tasks?: TaskContributionRegistry
  quarantine?: QuarantineManager
  safeMode?: SafeModeState
}

function getDeclaredDependencies(def: ModuleDefinition): string[] {
  const deps = def.manifest.dependencies
  if (!deps) return []
  if (Array.isArray(deps)) return (deps as string[]).map(toCanonicalModuleId)
  if (typeof deps === "object") return Object.keys(deps).map(toCanonicalModuleId)
  return []
}

function sortModulesByDependency(
  moduleIds: Iterable<string>,
  definitions: Map<string, ModuleDefinition>,
  reverse = false,
): string[] {
  const list = Array.from(moduleIds)
  const visited = new Set<string>()
  const result: string[] = []

  const visit = (id: string, stack: Set<string>) => {
    if (visited.has(id)) return
    if (stack.has(id)) {
      return
    }
    stack.add(id)
    const def = definitions.get(id)
    if (def) {
      const deps = getDeclaredDependencies(def)
      for (const depId of deps) {
        if (definitions.has(depId)) {
          visit(depId, stack)
        }
      }
    }
    stack.delete(id)
    visited.add(id)
    result.push(id)
  }

  for (const id of list) {
    visit(id, new Set())
  }

  return reverse ? result.reverse() : result
}

export class ModuleHost {
  public readonly files: FileHandlerRegistry
  public readonly panels: PanelContributionRegistry
  public readonly commands: CommandContributionRegistry
  public readonly tasks: TaskContributionRegistry
  public readonly quarantine: QuarantineManager
  public readonly safeMode: SafeModeState

  private definitions = new Map<string, ModuleDefinition>()
  private activeModules = new Set<string>()
  private activeContexts = new Map<string, ModuleHostContext>()
  private currentVault: string | null = null
  private syncQueue: Promise<void> = Promise.resolve()

  constructor(options?: ModuleHostOptions) {
    this.files = options?.files ?? new FileHandlerRegistry()
    this.panels = options?.panels ?? new PanelContributionRegistry()
    this.commands = options?.commands ?? new CommandContributionRegistry()
    this.tasks = options?.tasks ?? new TaskContributionRegistry()
    this.quarantine = options?.quarantine ?? quarantineManager
    this.safeMode = options?.safeMode ?? safeModeState
  }

  registerModule(def: ModuleDefinition): void {
    const canonicalId = toCanonicalModuleId(def.manifest.id)
    this.definitions.set(canonicalId, def)
  }

  getModuleDefinition(moduleId: string): ModuleDefinition | undefined {
    return this.definitions.get(toCanonicalModuleId(moduleId))
  }

  isModuleActive(moduleId: string): boolean {
    return this.activeModules.has(toCanonicalModuleId(moduleId))
  }

  getActiveModuleIds(): string[] {
    return Array.from(this.activeModules)
  }

  getCurrentVault(): string | null {
    return this.currentVault
  }

  getModuleContext(moduleId: string): ModuleHostContext | undefined {
    return this.activeContexts.get(toCanonicalModuleId(moduleId))
  }

  createExtensionApi(def: ModuleDefinition, context: ModuleHostContext): ExtensionApi {
    const broker = new CapabilityBroker(def.manifest, context)
    const canonicalId = toCanonicalModuleId(def.manifest.id)

    return {
      context,
      hasPermission: (p) => broker.hasPermission(p),
      requirePermission: (p) => broker.requirePermission(p),
      readFile: (relPath) => broker.readFile(relPath),
      writeFile: (relPath, contents) => broker.writeFile(relPath, contents),
      files: {
        register: (handler) => this.files.register(handler),
      },
      panels: {
        register: (panel) => this.panels.register(panel, canonicalId),
      },
      commands: {
        register: (action) => this.commands.register(action, canonicalId),
      },
      tasks: {
        register: (task) => this.tasks.register(task),
      },
    }
  }

  async loadInstalledModule(moduleId: string): Promise<ModuleDefinition | null> {
    const canonicalId = toCanonicalModuleId(moduleId)
    const existing = this.definitions.get(canonicalId)
    if (existing) {
      return existing
    }

    if (!canExecuteInstalledModules()) {
      logger.warn("module_host.installed_module_execution_disabled", { moduleId: canonicalId })
      return null
    }

    if (isTauri()) {
      try {
        const res = await commands.getModuleEntryPath(canonicalId)
        if (res.status === "ok" && res.data) {
          const { convertFileSrc } = await import("@tauri-apps/api/core")
          const assetUrl = convertFileSrc(res.data)
          const imported = (await import(/* @vite-ignore */ assetUrl)) as Record<string, unknown>
          const def = (imported.definition || imported.default || imported) as
            ModuleDefinition | undefined
          if (
            def &&
            typeof def === "object" &&
            "manifest" in def &&
            typeof def.activate === "function"
          ) {
            this.registerModule(def)
            return def
          }
        }
      } catch (error) {
        console.error(`Failed to dynamically load module "${canonicalId}":`, error)
      }
    }

    return null
  }

  async activateModule(moduleId: string, vault: string | null): Promise<boolean> {
    const canonicalId = toCanonicalModuleId(moduleId)
    if (this.activeModules.has(canonicalId)) {
      return true
    }

    if (this.quarantine.isQuarantined(canonicalId)) {
      console.warn(`Module "${canonicalId}" is quarantined and cannot be activated.`)
      return false
    }

    let def = this.definitions.get(canonicalId)
    if (!def) {
      def = (await this.loadInstalledModule(canonicalId)) ?? undefined
    }

    if (!def) {
      // Not registered with ModuleHost (might be a legacy module definition or not installed)
      return false
    }

    // Check declared dependencies: all must be currently active
    const declaredDeps = getDeclaredDependencies(def)
    for (const depId of declaredDeps) {
      if (!this.activeModules.has(depId)) {
        logger.warn("module_host.missing_dependency", {
          moduleId: canonicalId,
          dependencyId: depId,
        })
        return false
      }
    }

    const context: ModuleHostContext = {
      moduleId: canonicalId,
      vault,
      isSafeMode: this.safeMode.isEnabled(),
    }

    const api = this.createExtensionApi(def, context)

    try {
      await def.activate(api)
      this.activeModules.add(canonicalId)
      this.activeContexts.set(canonicalId, context)
      return true
    } catch (error) {
      console.error(`Failed to activate module "${canonicalId}":`, error)
      this.quarantine.recordFailure(canonicalId, error)
      await this.deactivateModule(canonicalId)
      return false
    }
  }

  async deactivateModule(moduleId: string): Promise<void> {
    const canonicalId = toCanonicalModuleId(moduleId)
    if (!this.activeModules.has(canonicalId)) {
      return
    }

    // Deactivate any active modules that depend on this one first (dependents before dependencies)
    for (const activeId of Array.from(this.activeModules)) {
      if (activeId === canonicalId) continue
      const activeDef = this.definitions.get(activeId)
      if (activeDef) {
        const deps = getDeclaredDependencies(activeDef)
        if (deps.includes(canonicalId)) {
          await this.deactivateModule(activeId)
        }
      }
    }

    const def = this.definitions.get(canonicalId)
    if (def?.deactivate) {
      try {
        await def.deactivate()
      } catch (error) {
        console.error(`Error deactivating module "${canonicalId}":`, error)
      }
    }

    // Unregister all contributions and stop tasks
    this.files.unregisterAllForModule(canonicalId)
    this.panels.unregisterAllForModule(canonicalId)
    this.commands.unregisterAllForModule(canonicalId)
    await this.tasks.stopAllForModule(canonicalId)

    this.activeModules.delete(canonicalId)
    this.activeContexts.delete(canonicalId)
  }

  async disposeModule(moduleId: string): Promise<void> {
    const canonicalId = toCanonicalModuleId(moduleId)
    await this.deactivateModule(canonicalId)

    const def = this.definitions.get(canonicalId)
    if (def?.dispose) {
      try {
        await def.dispose()
      } catch (error) {
        console.error(`Error disposing module "${canonicalId}":`, error)
      }
    }

    this.definitions.delete(canonicalId)
  }

  syncWithWorkspace(enabledModules: string[], vault: string | null): Promise<void> {
    const run = async () => {
      const canonicalEnabled = new Set(enabledModules.map(toCanonicalModuleId))
      const vaultChanged = this.currentVault !== vault
      this.currentVault = vault

      if (vaultChanged) {
        // Vault context changed: full restart of active modules with new vault context
        // Deactivate in reverse dependency order (dependents first)
        const activeToDeactivate = sortModulesByDependency(
          this.activeModules,
          this.definitions,
          true,
        )
        for (const activeId of activeToDeactivate) {
          await this.deactivateModule(activeId)
        }

        // Activate in dependency order (dependencies first)
        const toActivate = sortModulesByDependency(canonicalEnabled, this.definitions, false)
        for (const enabledId of toActivate) {
          if (canonicalEnabled.has(enabledId) && this.definitions.has(enabledId)) {
            await this.activateModule(enabledId, vault)
          }
        }
      } else {
        // Same vault: delta sync
        // 1. Deactivate modules that are no longer enabled (dependents first)
        const toDeactivate = sortModulesByDependency(
          Array.from(this.activeModules).filter((id) => !canonicalEnabled.has(id)),
          this.definitions,
          true,
        )
        for (const activeId of toDeactivate) {
          await this.deactivateModule(activeId)
        }

        // 2. Activate newly enabled modules (dependencies first)
        const toActivate = sortModulesByDependency(
          Array.from(canonicalEnabled).filter((id) => !this.activeModules.has(id)),
          this.definitions,
          false,
        )
        for (const enabledId of toActivate) {
          if (
            canonicalEnabled.has(enabledId) &&
            !this.activeModules.has(enabledId) &&
            this.definitions.has(enabledId)
          ) {
            await this.activateModule(enabledId, vault)
          }
        }
      }
    }

    this.syncQueue = this.syncQueue.then(run, run)
    return this.syncQueue
  }

  async disposeAll(): Promise<void> {
    const activeToDeactivate = sortModulesByDependency(this.activeModules, this.definitions, true)
    for (const activeId of activeToDeactivate) {
      await this.deactivateModule(activeId)
    }
    for (const defId of Array.from(this.definitions.keys())) {
      await this.disposeModule(defId)
    }
    this.files.clear()
    this.panels.clear()
    this.commands.clear()
    this.tasks.clear()
    this.quarantine.clear()
    this.currentVault = null
    this.activeContexts.clear()
  }
}

export const moduleHost = new ModuleHost()
