import { Calendar } from "lucide-react"
import type { ModuleDefinition } from "@/lib/modules/host"

/** Today's note: one activity-bar action. The note is opened or made by Rust. */
export const DAILY_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.daily",
    name: "Daily notes",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.9",
    permissions: ["ui-action", "read-notes", "write-notes"],
    contributions: {
      commands: ["daily"],
    },
  },
  activate: (api) => {
    api.commands.register({
      id: "daily",
      labelKey: "actions.daily",
      icon: Calendar,
      kind: "action",
      invoke: (context) => context.openDailyNote?.(),
    })
  },
  deactivate: () => {},
}

/**
 * Templates add "From template" to the creation menus while the module is on (see
 * `useNoteModulesEnabled`); there is no panel or action of their own.
 */
export const TEMPLATES_MODULE_DEFINITION: ModuleDefinition = {
  manifest: {
    formatVersion: 1,
    id: "amby.templates",
    name: "Templates",
    version: "1.0.0",
    publisher: "Amby",
    kind: "official",
    minAppVersion: "0.1.9",
    permissions: ["read-notes", "write-notes"],
    contributions: {},
  },
  activate: () => {},
  deactivate: () => {},
}
