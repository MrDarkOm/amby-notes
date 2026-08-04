import type { PanelId } from "./panel-registry"

/** Core workspace tools are always present and therefore are not modules. */
export const BASE_DEF_IDS = new Set(["files", "search", "archive", "info", "refresh"])

/**
 * A capability a module declares it needs. Today these are advisory and
 * enforced in-process; the same manifest is what a WASM/dynamic-lib sandbox
 * would gate against in a later phase, so modules declare them from day one.
 */
export type ModulePermission =
  "read-notes" | "write-notes" | "read-vault-meta" | "ui-panel" | "ui-action"

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
  manifest: ModuleManifest
  /** Panels (from panel-registry) this module contributes to the activity bar. */
  panels?: PanelId[]
  /** Action ids this module contributes. */
  actions?: string[]
  onActivate?: (ctx: ModuleContext) => void
  onDeactivate?: (ctx: ModuleContext) => void
}

/**
 * The built-in modules. Each wraps one of the existing panels/actions; this is
 * the seam the Preset Engine and (later) third-party plugins slot into.
 */
export const MODULE_REGISTRY: ModuleDef[] = [
  {
    id: "tags",
    labelKey: "settings.modules.tags",
    manifest: { permissions: ["ui-panel", "read-notes"] },
    panels: ["tags"],
  },
  {
    id: "favorites",
    labelKey: "settings.modules.favorites",
    manifest: { permissions: ["ui-panel", "read-vault-meta"] },
    panels: ["favorites"],
  },
  {
    id: "databases",
    labelKey: "settings.modules.databases",
    manifest: { permissions: ["ui-panel"] },
    panels: ["databases"],
  },
  {
    id: "history",
    labelKey: "settings.modules.history",
    manifest: { permissions: ["ui-panel"] },
    panels: ["history"],
  },
  {
    id: "links",
    labelKey: "settings.modules.links",
    manifest: { permissions: ["ui-panel", "read-vault-meta"] },
    panels: ["links"],
  },
  {
    id: "graph",
    labelKey: "settings.modules.graph",
    manifest: { permissions: ["ui-action", "read-vault-meta"] },
    actions: ["network"],
  },
  { id: "sync", labelKey: "settings.modules.sync", manifest: { permissions: ["read-vault-meta"] } },
  {
    id: "ai",
    labelKey: "settings.modules.ai",
    manifest: { permissions: ["ui-panel", "read-notes", "write-notes"] },
    panels: ["ai"],
  },
]

export const ALL_MODULE_IDS: string[] = MODULE_REGISTRY.map((m) => m.id)

export function findModule(id: string): ModuleDef | undefined {
  return MODULE_REGISTRY.find((m) => m.id === id)
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

/** Run on_deactivate/on_activate hooks for the transition prev -> next. */
export function runModuleLifecycle(prev: string[], next: string[], ctx: ModuleContext): void {
  const prevSet = new Set(prev)
  const nextSet = new Set(next)
  for (const id of prev) {
    if (!nextSet.has(id)) findModule(id)?.onDeactivate?.(ctx)
  }
  for (const id of next) {
    if (!prevSet.has(id)) findModule(id)?.onActivate?.(ctx)
  }
}
