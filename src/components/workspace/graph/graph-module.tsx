import { Network } from "lucide-react"
import type { ModuleDefinition } from "@/lib/modules/host"

export const GRAPH_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.graph",
    name: "Graph",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-action", "read-vault-meta"],
    contributions: {
      commands: ["network"],
    },
  },
  activate: (api) => {
    api.commands.register({
      id: "network",
      labelKey: "actions.network",
      icon: Network,
      kind: "action",
      invoke: (context) => context.openGraphTab(),
    })
  },
  deactivate: () => {
    // Graph cleanup
  },
}
