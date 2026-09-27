import { Database } from "lucide-react"
import { DatabasesPanel } from "../panels/databases-panel"
import type { ModuleDefinition } from "@/lib/modules/host"

export const DATABASES_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.databases",
    name: "Databases",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-databases", "write-databases", "vault.read", "vault.write"],
    contributions: {
      panels: ["databases"],
      fileHandlers: [".ambd"],
    },
    data: {
      namespace: ".ambd",
      uninstallPolicy: "preserve",
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "databases",
      labelKey: "panels.databases",
      icon: Database,
      kind: "view",
      render: (props) => <DatabasesPanel {...props} />,
    })
    api.files.register({
      extension: ".ambd",
      moduleId: "amby.databases",
      viewKind: "database",
    })
  },
  deactivate: () => {
    // Database panel cleanup
  },
}
