import type { ModuleDefinition } from "@/lib/modules/host"

export const CANVAS_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.canvas",
    name: "Canvas",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-notes", "write-notes", "vault.read", "vault.write"],
    contributions: {
      fileHandlers: [".canvas"],
    },
    data: {
      namespace: "canvas",
      uninstallPolicy: "preserve",
    },
  },
  activate: (api) => {
    api.files.register({
      extension: ".canvas",
      moduleId: "amby.canvas",
      viewKind: "canvas",
    })
  },
  deactivate: () => {
    // Canvas cleanup
  },
}
