import { Sparkles } from "lucide-react"
import { AiPanel } from "../ai-panel"
import type { ModuleDefinition } from "@/lib/modules/host"

export const AI_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.ai",
    name: "AI",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-notes", "write-notes"],
    contributions: {
      panels: ["ai"],
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "ai",
      labelKey: "panels.ai",
      icon: Sparkles,
      kind: "view",
      render: (props) => <AiPanel {...props} />,
    })
  },
  deactivate: () => {
    // AI cleanup
  },
}
