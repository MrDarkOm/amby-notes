import { Link as LinkIcon } from "lucide-react"
import { LinksPanel } from "../panels/links-panel"
import type { ModuleDefinition } from "@/lib/modules/host"

export const LINKS_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.links",
    name: "Links",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-vault-meta"],
    contributions: {
      panels: ["links"],
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "links",
      labelKey: "panels.links",
      icon: LinkIcon,
      kind: "view",
      render: (props) => <LinksPanel {...props} />,
    })
  },
  deactivate: () => {
    // Links cleanup
  },
}
