import type { PanelId } from "./panel-registry"

/**
 * A capability a module declares it needs. Today these are advisory and
 * enforced in-process; the same manifest is what a WASM/dynamic-lib sandbox
 * would gate against in a later phase, so modules declare them from day one.
 */
export type ModulePermission =
  | "read-notes"
  | "write-notes"
  | "read-vault-meta"
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
  label: string
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
  { id: "files", label: "Древо файлов", manifest: { permissions: ["ui-panel", "read-vault-meta"] }, panels: ["files"] },
  { id: "search", label: "Поиск", manifest: { permissions: ["ui-action", "read-notes"] }, actions: ["search"] },
  { id: "tags", label: "Теги", manifest: { permissions: ["ui-panel", "read-notes"] }, panels: ["tags"] },
  { id: "favorites", label: "Избранное", manifest: { permissions: ["ui-panel", "read-vault-meta"] }, panels: ["favorites"] },
  { id: "databases", label: "Базы данных", manifest: { permissions: ["ui-panel"] }, panels: ["databases"] },
  { id: "archive", label: "Архив", manifest: { permissions: ["ui-panel"] }, panels: ["archive"] },
  { id: "properties", label: "Свойства", manifest: { permissions: ["ui-panel", "read-notes"] }, panels: ["info"] },
  { id: "history", label: "История", manifest: { permissions: ["ui-panel"] }, panels: ["history"] },
  { id: "links", label: "Ссылки", manifest: { permissions: ["ui-panel", "read-vault-meta"] }, panels: ["links"] },
  { id: "graph", label: "Граф связей", manifest: { permissions: ["ui-action", "read-vault-meta"] }, actions: ["network"] },
  { id: "sync", label: "Синхронизация", manifest: { permissions: ["ui-action", "read-vault-meta"] }, actions: ["refresh"] },
  { id: "ai", label: "AI", manifest: { permissions: ["ui-panel", "read-notes", "write-notes"] }, panels: ["ai"] },
]

export const ALL_MODULE_IDS: string[] = MODULE_REGISTRY.map(m => m.id)

export function findModule(id: string): ModuleDef | undefined {
  return MODULE_REGISTRY.find(m => m.id === id)
}

/** The panel + action defIds contributed by a set of active modules. */
export function contributedDefIds(activeModuleIds: string[]): Set<string> {
  const ids = new Set<string>()
  for (const moduleId of activeModuleIds) {
    const mod = findModule(moduleId)
    if (!mod) continue
    mod.panels?.forEach(p => ids.add(p))
    mod.actions?.forEach(a => ids.add(a))
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
