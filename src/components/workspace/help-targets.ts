import type { ShortcutActionId } from "./keyboard-shortcuts"

export const HELP_GROUPS = [
  { id: "navigation", side: "left", icon: "tabs" },
  { id: "application", side: "left", icon: "panels" },
  { id: "files", side: "left", icon: "files" },
  { id: "workspace", side: "left", icon: "workspace" },
  { id: "page", side: "right", icon: "page" },
  { id: "editor", side: "right", icon: "editor" },
  { id: "context", side: "right", icon: "context" },
  { id: "tools", side: "right", icon: "tools" },
] as const

export type HelpGroupId = (typeof HELP_GROUPS)[number]["id"]
export interface HelpTarget {
  id: string
  group: HelpGroupId
  selectors: string[]
  page?: boolean
  preferPane?: boolean
  shortcut?: ShortcutActionId
}

/** Explicit anchors survive translations, reordered docks and cached editors. */
export const HELP_TARGETS: HelpTarget[] = [
  {
    id: "tabs",
    preferPane: true,
    group: "navigation",
    selectors: ["[data-active-tab=true]", "[data-pane-tab-bar]"],
  },
  {
    id: "newTab",
    preferPane: true,
    group: "navigation",
    selectors: ['[data-spotlight-origin="new-tab"]'],
  },
  {
    id: "sections",
    group: "application",
    selectors: [
      '[data-activity-bar="left"] [data-activity-zone="view"][data-active="true"]',
      '[data-activity-bar="left"] [data-activity-button="files"]',
    ],
  },
  {
    id: "search",
    group: "application",
    selectors: ['[data-activity-button="search"]'],
    shortcut: "search",
  },
  {
    id: "settings",
    group: "application",
    selectors: ['[data-activity-button="settings"]'],
    shortcut: "settings",
  },
  { id: "fileSearch", group: "files", selectors: ['[data-help-scope="files"] input'] },
  { id: "fileTools", group: "files", selectors: ['[data-help-scope="files"] > header'] },
  { id: "tree", group: "files", selectors: ['[data-help-scope="files"] [role="tree"]'] },
  {
    id: "create",
    group: "workspace",
    selectors: ['[data-help-target="create"]'],
    shortcut: "newNote",
  },
  { id: "workspace", group: "workspace", selectors: ['[data-help-target="workspace"]'] },
  {
    id: "pageHistory",
    group: "navigation",
    selectors: ['[data-help-target="page-history"]'],
    page: true,
    shortcut: "back",
  },
  { id: "focus", group: "page", selectors: ['[data-help-target="focus"]'], page: true },
  {
    id: "breadcrumbs",
    group: "page",
    selectors: [
      '[data-help-target="breadcrumbs"] [data-breadcrumb-segment]',
      '[data-help-target="breadcrumbs"]',
    ],
    page: true,
  },
  { id: "pageMenu", group: "page", selectors: ['[data-help-target="page-menu"]'], page: true },
  { id: "layers", group: "page", selectors: ['[data-help-target="layers"]'], page: true },
  {
    id: "content",
    group: "editor",
    selectors: [
      ".ProseMirror",
      ".cm-editor",
      ".react-flow",
      ".excalidraw",
      "[data-pane-id]",
      '[data-help-area="content"]',
    ],
    page: true,
  },
  { id: "info", group: "context", selectors: ['[data-activity-button="info"]'] },
  { id: "attachments", group: "context", selectors: ['[data-activity-button="attachments"]'] },
  { id: "history", group: "context", selectors: ['[data-activity-button="history"]'] },
  { id: "links", group: "context", selectors: ['[data-activity-button="links"]'] },
  { id: "ai", group: "context", selectors: ['[data-activity-button="ai"]'] },
  { id: "stats", group: "tools", selectors: ['[data-help-target="page-stats"]'], page: true },
  { id: "undo", group: "tools", selectors: ['[data-help-target="undo"]'], page: true },
  { id: "lock", group: "tools", selectors: ['[data-help-target="lock"]'], page: true },
  {
    id: "pageSettings",
    group: "tools",
    selectors: ['[data-help-target="page-settings"]'],
    page: true,
  },
]
