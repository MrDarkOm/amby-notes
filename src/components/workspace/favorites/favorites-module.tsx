import { Bookmark } from "lucide-react"
import { FavoritesPanel } from "../panels/favorites-panel"
import type { ModuleDefinition } from "@/lib/modules/host"

export const FAVORITES_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.favorites",
    name: "Favorites",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["ui-panel", "read-vault-meta"],
    contributions: {
      panels: ["favorites"],
    },
  },
  activate: (api) => {
    api.panels.register({
      id: "favorites",
      labelKey: "panels.favorites",
      icon: Bookmark,
      kind: "view",
      render: (props) => <FavoritesPanel {...props} />,
    })
  },
  deactivate: () => {
    // Favorites cleanup
  },
}
