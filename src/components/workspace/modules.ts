import type { PanelId } from "./panel-registry"

/** Core workspace tools are always present and therefore are not modules. */
export const BASE_DEF_IDS = new Set(["files", "search", "archive", "info", "refresh"])

/**
 * A capability a module declares it needs. Today these are advisory and
 * enforced in-process; the same manifest is what a WASM/dynamic-lib sandbox
 * would gate against in a later phase, so modules declare them from day one.
 */
export type ModulePermission =
  | "read-notes"
  | "write-notes"
  | "read-vault-meta"
  | "read-databases"
  | "write-databases"
  | "ui-panel"
  | "ui-action"

export interface ModuleManifest {
  permissions: ModulePermission[]
}

/** Narrow context handed to lifecycle hooks — widened as modules need more. */
export interface ModuleContext {
  vault: string | null
}

export interface ModuleDef {
  id: string
  labelKey: string
  descriptionKey: string
  /** Preview modules are visible in the catalogue but cannot be enabled yet. */
  status: "ready" | "beta" | "preview"
  manifest: ModuleManifest
  /** Panels (from panel-registry) this module contributes to the activity bar. */
  panels?: PanelId[]
  /** Action ids this module contributes. */
  actions?: string[]
  /** Flush pending work before the module is committed as disabled. */
  prepareDeactivate?: (ctx: ModuleContext) => void | Promise<void>
  onActivate?: (ctx: ModuleContext) => void
  onDeactivate?: (ctx: ModuleContext) => void
}

export interface ModuleAvailability {
  databasesV1: boolean
}

export const DEFAULT_MODULE_AVAILABILITY: ModuleAvailability = {
  databasesV1: false,
}

/** Database layer creation uses the durable DB-10 creator, not Metadata.md. */
export const DATABASE_LAYER_CREATION_AVAILABLE = true

/**
 * The built-in modules. Each wraps one of the existing panels/actions; this is
 * the seam the Preset Engine and (later) third-party plugins slot into.
 */
export const MODULE_REGISTRY: ModuleDef[] = [
  {
    id: "tags",
    labelKey: "settings.modules.tags",
    descriptionKey: "settings.modules.descriptions.tags",
    status: "ready",
    manifest: { permissions: ["ui-panel", "read-notes"] },
    panels: ["tags"],
  },
  {
    id: "favorites",
    labelKey: "settings.modules.favorites",
    descriptionKey: "settings.modules.descriptions.favorites",
    status: "ready",
    manifest: { permissions: ["ui-panel", "read-vault-meta"] },
    panels: ["favorites"],
  },
  {
    id: "databases",
    labelKey: "settings.modules.databases",
    descriptionKey: "settings.modules.descriptions.databases",
    status: "beta",
    manifest: { permissions: ["ui-panel", "read-databases", "write-databases"] },
    panels: ["databases"],
  },
  {
    id: "history",
    labelKey: "settings.modules.history",
    descriptionKey: "settings.modules.descriptions.history",
    status: "ready",
    manifest: { permissions: ["ui-panel"] },
    panels: ["history"],
  },
  {
    id: "links",
    labelKey: "settings.modules.links",
    descriptionKey: "settings.modules.descriptions.links",
    status: "ready",
    manifest: { permissions: ["ui-panel", "read-vault-meta"] },
    panels: ["links"],
  },
  {
    id: "graph",
    labelKey: "settings.modules.graph",
    descriptionKey: "settings.modules.descriptions.graph",
    status: "ready",
    manifest: { permissions: ["ui-action", "read-vault-meta"] },
    actions: ["network"],
  },
  {
    id: "sync",
    labelKey: "settings.modules.sync",
    descriptionKey: "settings.modules.descriptions.sync",
    status: "preview",
    manifest: { permissions: ["read-vault-meta"] },
  },
  {
    id: "ai",
    labelKey: "settings.modules.ai",
    descriptionKey: "settings.modules.descriptions.ai",
    status: "ready",
    manifest: { permissions: ["ui-panel", "read-notes", "write-notes"] },
    panels: ["ai"],
  },
]

export const ALL_MODULE_IDS: string[] = MODULE_REGISTRY.map((m) => m.id)
/** Modules enabled by the Standard preset. Preview entries stay discoverable but inactive. */
export const READY_MODULE_IDS: string[] = MODULE_REGISTRY.filter(
  (module) => module.status === "ready",
).map((module) => module.id)

export function findModule(id: string): ModuleDef | undefined {
  return MODULE_REGISTRY.find((m) => m.id === id)
}

/**
 * Preview modules remain visible in Settings but cannot be enabled. Beta
 * modules are explicitly available without silently entering new presets.
 */
export function isModuleAvailable(
  id: string,
  _experimental: ModuleAvailability = DEFAULT_MODULE_AVAILABILITY,
): boolean {
  const module = findModule(id)
  if (!module) return false
  return module.status !== "preview"
}

export function availableModuleIds(
  experimental: ModuleAvailability = DEFAULT_MODULE_AVAILABILITY,
): string[] {
  return MODULE_REGISTRY.filter((module) => isModuleAvailable(module.id, experimental)).map(
    (module) => module.id,
  )
}

/** The panel + action defIds contributed by a set of active modules. */
export function contributedDefIds(activeModuleIds: string[]): Set<string> {
  const ids = new Set<string>(BASE_DEF_IDS)
  for (const moduleId of activeModuleIds) {
    const mod = findModule(moduleId)
    if (!mod) continue
    mod.panels?.forEach((p) => ids.add(p))
    mod.actions?.forEach((a) => ids.add(a))
  }
  return ids
}
