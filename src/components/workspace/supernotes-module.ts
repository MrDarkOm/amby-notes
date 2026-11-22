import type { ModuleDefinition } from "@/lib/modules/host"

export const SUPERNOTES_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.supernotes",
    name: "Supernotes",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.9",
    permissions: ["read-notes", "write-notes"],
    contributions: {},
  },
  activate: () => {},
  deactivate: () => {},
}
