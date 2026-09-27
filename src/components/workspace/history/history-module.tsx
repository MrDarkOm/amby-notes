import { History } from "lucide-react"
import { HistoryPanel } from "../panels/history-panel"
import type { ModuleDefinition } from "@/lib/modules/host"

export const HISTORY_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.history",
    name: "History",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["vault.read", "vault.write", "ui-panel"],
    contributions: {
      panels: ["history"],
      commands: ["history.restore", "history.cleanup"],
      settings: true,
    },
    data: {
      namespace: ".amby/history",
      uninstallPolicy: "preserve",
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "history",
      labelKey: "panels.history",
      icon: History,
      kind: "view",
      render: (props) => <HistoryPanel {...props} />,
    })
  },
  deactivate: () => {
    // History cleanup
  },
}
