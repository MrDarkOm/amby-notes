import type { ModuleDefinition } from "@/lib/modules/host"

export const SKETCH_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.excalidraw",
    name: "Excalidraw",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-notes", "write-notes", "vault.read", "vault.write"],
    contributions: {
      fileHandlers: [".excalidraw", ".sketch"],
    },
    data: {
      namespace: "excalidraw",
      uninstallPolicy: "preserve",
    },
  },
  activate: (api) => {
    api.files.register({
      extension: ".excalidraw",
      moduleId: "amby.excalidraw",
      viewKind: "sketch",
    })
    api.files.register({
      extension: ".sketch",
      moduleId: "amby.excalidraw",
      viewKind: "sketch",
    })
  },
  deactivate: () => {
    // Sketch cleanup
  },
}
