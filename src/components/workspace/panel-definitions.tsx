import {
  Archive,
  FolderTree,
  HelpCircle,
  Info,
  LayoutTemplate,
  Paperclip,
  RefreshCw,
  Search,
  Settings,
} from "lucide-react"

import {
  FilesPanel,
  InfoPanel,
  AttachmentsPanel,
  type ActionDef,
  type ActivityButton,
  type ButtonDef,
  type PanelDef,
  type PanelId,
  type Side,
} from "./panel-registry"
import { ArchivePanel } from "./panels/archive-panel"
import { moduleHost } from "@/lib/modules/host"

/**
 * Core built-in panels that do not belong to optional modules.
 * Modular panels (tags, favorites, databases, history, links, ai) are
 * contributed exclusively through moduleHost.panels.
 */
export const PANEL_DEFS: PanelDef[] = [
  {
    id: "files",
    labelKey: "panels.files",
    icon: FolderTree,
    kind: "view",
    render: (props) => <FilesPanel {...props} />,
  },
  {
    id: "archive",
    labelKey: "panels.archive",
    icon: Archive,
    kind: "view",
    render: (props) => <ArchivePanel {...props} />,
  },
  {
    id: "info",
    labelKey: "panels.info",
    icon: Info,
    kind: "view",
    render: (props) => <InfoPanel {...props} />,
  },
  {
    id: "attachments",
    labelKey: "panels.attachments",
    icon: Paperclip,
    kind: "view",
    render: (props) => <AttachmentsPanel {...props} />,
  },
]

/**
 * Core built-in actions. Modular actions (e.g. network/graph)
 * are contributed exclusively through moduleHost.commands.
 */
export const ACTION_DEFS: ActionDef[] = [
  {
    id: "search",
    labelKey: "actions.search",
    icon: Search,
    kind: "action",
    invoke: (context) => context.openSearch(),
  },
  {
    id: "refresh",
    labelKey: "actions.refresh",
    icon: RefreshCw,
    kind: "action",
    persistent: true,
    invoke: (context) => context.refreshVault(),
  },
  {
    id: "presets",
    labelKey: "actions.presets",
    icon: LayoutTemplate,
    kind: "action",
    persistent: true,
  },
  {
    id: "help",
    labelKey: "actions.help",
    icon: HelpCircle,
    kind: "action",
    persistent: true,
    invoke: (context) => context.openHelp?.(),
  },
  {
    id: "settings",
    labelKey: "actions.settings",
    icon: Settings,
    kind: "action",
    persistent: true,
    invoke: (context) => context.openSettings(),
  },
]

export function findPanelDef(panelId: PanelId | string): PanelDef | undefined {
  return (
    moduleHost.panels.getPanel(panelId) ??
    PANEL_DEFS.find((definition) => definition.id === panelId)
  )
}

export function findButtonDef(defId: string): ButtonDef | undefined {
  return (
    findPanelDef(defId) ??
    moduleHost.commands.getCommand(defId) ??
    ACTION_DEFS.find((definition) => definition.id === defId)
  )
}

export const PERSISTENT_ACTION_BUTTONS: ActivityButton[] = [
  { defId: "refresh", side: "left", order: 1 },
  { defId: "presets", side: "left", order: 3 },
  { defId: "help", side: "left", order: 4 },
  { defId: "settings", side: "left", order: 5 },
]

export const DEFAULT_BUTTONS: ActivityButton[] = [
  { defId: "files", side: "left", order: 0 },
  { defId: "tags", side: "left", order: 1 },
  { defId: "favorites", side: "left", order: 2 },
  { defId: "databases", side: "left", order: 3 },
  { defId: "archive", side: "left", order: 4 },
  { defId: "creative", side: "left", order: 5 },
  { defId: "search", side: "left", order: 0 },
  { defId: "network", side: "left", order: 2 },
  { defId: "info", side: "right", order: 0 },
  { defId: "attachments", side: "right", order: 1 },
  { defId: "history", side: "right", order: 2 },
  { defId: "links", side: "right", order: 3 },
  { defId: "ai", side: "right", order: 4 },
  ...PERSISTENT_ACTION_BUTTONS,
]

export function buttonsForSide(buttons: ActivityButton[], side: Side): ActivityButton[] {
  const seen = new Set<string>()
  return buttons
    .filter((button) => {
      if (button.side !== side || seen.has(button.defId)) return false
      seen.add(button.defId)
      return true
    })
    .slice()
    .sort((left, right) => left.order - right.order)
}

/** Returns the first view-button on a side, or null if none. */
export function firstViewOnSide(buttons: ActivityButton[], side: Side): PanelId | null {
  for (const button of buttonsForSide(buttons, side)) {
    const definition = findButtonDef(button.defId)
    if (definition?.kind === "view") return definition.id
  }
  return null
}
