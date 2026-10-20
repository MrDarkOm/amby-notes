import type { ModuleDefinition } from "@/lib/modules/host"

/** The optional sync module (docs/sync-plan.md, Р12). Off by default; it adds a settings section. */
export const SYNC_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.sync",
    name: "Sync",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: [],
  },
  activate: () => {},
  deactivate: () => {},
}
