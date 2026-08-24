import {
  Archive,
  Bookmark,
  Database,
  FolderTree,
  History,
  Info,
  LayoutTemplate,
  Link as LinkIcon,
  Network,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tag,
} from "lucide-react"

import { AiPanel } from "./ai-panel"
import {
  ComingSoonPanel,
  FavoritesPanel,
  FilesPanel,
  HistoryPanel,
  InfoPanel,
  LinksPanel,
  TagsPanel,
  type ActionDef,
  type ActivityButton,
  type ButtonDef,
  type PanelDef,
  type PanelId,
  type Side,
} from "./panel-registry"

export const PANEL_DEFS: PanelDef[] = [
  {
    id: "files",
    labelKey: "panels.files",
    icon: FolderTree,
    kind: "view",
    render: (props) => <FilesPanel {...props} />,
  },
  {
    id: "tags",
    labelKey: "panels.tags",
    icon: Tag,
    kind: "view",
    render: (props) => <TagsPanel {...props} />,
  },
  {
    id: "favorites",
    labelKey: "panels.favorites",
    icon: Bookmark,
    kind: "view",
    render: (props) => <FavoritesPanel {...props} />,
  },
  {
    id: "databases",
    labelKey: "panels.databases",
    icon: Database,
    kind: "view",
    render: () => <ComingSoonPanel labelKey="panels.databases" />,
  },
  {
    id: "archive",
    labelKey: "panels.archive",
    icon: Archive,
    kind: "view",
    render: () => <ComingSoonPanel labelKey="panels.archive" />,
  },
  {
    id: "info",
    labelKey: "panels.info",
    icon: Info,
    kind: "view",
    render: (props) => <InfoPanel {...props} />,
  },
  {
    id: "history",
    labelKey: "panels.history",
    icon: History,
    kind: "view",
    render: (props) => <HistoryPanel {...props} />,
  },
  {
    id: "links",
    labelKey: "panels.links",
    icon: LinkIcon,
    kind: "view",
    render: (props) => <LinksPanel {...props} />,
  },
  {
    id: "ai",
    labelKey: "panels.ai",
    icon: Sparkles,
    kind: "view",
    render: (props) => <AiPanel {...props} />,
  },
]

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
    id: "network",
    labelKey: "actions.network",
    icon: Network,
    kind: "action",
    invoke: (context) => context.openGraphTab(),
  },
  {
    id: "presets",
    labelKey: "actions.presets",
    icon: LayoutTemplate,
    kind: "action",
    persistent: true,
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

export function findButtonDef(defId: string): ButtonDef | undefined {
  return (
    PANEL_DEFS.find((definition) => definition.id === defId) ??
    ACTION_DEFS.find((definition) => definition.id === defId)
  )
}

export const PERSISTENT_ACTION_BUTTONS: ActivityButton[] = [
  { defId: "refresh", side: "left", order: 1 },
  { defId: "presets", side: "left", order: 3 },
  { defId: "settings", side: "left", order: 4 },
]

export const DEFAULT_BUTTONS: ActivityButton[] = [
  { defId: "files", side: "left", order: 0 },
  { defId: "tags", side: "left", order: 1 },
  { defId: "favorites", side: "left", order: 2 },
  { defId: "databases", side: "left", order: 3 },
  { defId: "archive", side: "left", order: 4 },
  { defId: "search", side: "left", order: 0 },
  { defId: "network", side: "left", order: 2 },
  { defId: "info", side: "right", order: 0 },
  { defId: "history", side: "right", order: 1 },
  { defId: "links", side: "right", order: 2 },
  { defId: "ai", side: "right", order: 3 },
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
