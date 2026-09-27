import { Tag } from "lucide-react"
import { TagsPanel } from "../panels/tags-panel"
import type { ModuleDefinition } from "@/lib/modules/host"

export const TAGS_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.tags",
    name: "Tags",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-notes"],
    contributions: {
      panels: ["tags"],
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "tags",
      labelKey: "panels.tags",
      icon: Tag,
      kind: "view",
      render: (props) => <TagsPanel {...props} />,
    })
  },
  deactivate: () => {
    // Tags panel cleanup
  },
}
