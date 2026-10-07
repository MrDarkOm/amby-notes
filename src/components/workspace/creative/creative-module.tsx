import { Feather } from "lucide-react"
import type { ModuleDefinition } from "@/lib/modules/host"
import { CreativePanel } from "./creative-panel"

export const CREATIVE_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.creative",
    name: "Творческая мастерская",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    dependencies: {
      "amby.databases": "^1.0.0",
    },
    permissions: ["ui-panel", "read-databases", "write-databases", "vault.read", "vault.write"],
    contributions: {
      panels: ["creative"],
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "creative",
      labelKey: "panels.creative",
      icon: Feather,
      kind: "view",
      render: (props) => <CreativePanel {...props} />,
    })
  },
}
