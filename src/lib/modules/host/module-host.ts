import { isTauri } from "@/lib/storage"
import { commands } from "@/lib/bindings"
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
        for (const activeId of Array.from(this.activeModules)) {
          await this.deactivateModule(activeId)
        }
        for (const enabledId of canonicalEnabled) {
          if (this.definitions.has(enabledId)) {
            await this.activateModule(enabledId, vault)
          }
        }
      } else {
        // Same vault: delta sync
        // 1. Deactivate modules that are no longer enabled
        for (const activeId of Array.from(this.activeModules)) {
          if (!canonicalEnabled.has(activeId)) {
            await this.deactivateModule(activeId)
          }
        }

        // 2. Activate newly enabled modules
        for (const enabledId of canonicalEnabled) {
          if (!this.activeModules.has(enabledId) && this.definitions.has(enabledId)) {
            await this.activateModule(enabledId, vault)
          }
        }
      }
    }

    this.syncQueue = this.syncQueue.then(run, run)
    return this.syncQueue
  }

  async disposeAll(): Promise<void> {
    for (const activeId of Array.from(this.activeModules)) {
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
