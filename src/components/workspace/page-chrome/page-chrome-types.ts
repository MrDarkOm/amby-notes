import type * as React from "react"
import type { HeaderTab } from "../header-tabs"

/** One step of a page's breadcrumb. The last crumb is the page itself and is never a link. */
export interface PageCrumb {
  key: string
  label: string
  /** A small glyph in front of the label (already sized: `size-3`). */
  icon?: React.ReactNode
  /** Makes the crumb a link; the last crumb ignores it. */
  onOpen?: () => void
}

/** One row of the "⋯" menu of a page. */
export interface PageMenuItem {
  id: string
  label: React.ReactNode
  /** The glyph, already sized and coloured by the surface (`size-3.5 text-muted-foreground`). */
  icon?: React.ReactNode
  /** The label fills the row even without a mark, so a mark that appears later has room. */
  growLabel?: boolean
  /** Set: the row is a choice, and `true` marks the one chosen. */
  checked?: boolean
  /** How the choice is marked: a "✓" (default) or the `Check` glyph. */
  checkStyle?: "mark" | "icon"
  /** Rows that open to the side, in groups that are told apart by a separator. */
  submenu?: PageMenuItem[][]
  /** The width class of that side menu (`w-48` by default). */
  submenuWidth?: string
  destructive?: boolean
  disabled?: boolean
  onSelect?: () => void
}

/** Rows that belong together; a separator stands between two groups that have rows. */
export type PageMenuGroup = PageMenuItem[]

/** The tab menu that names the page in focus mode, where there is no tab bar. */
export interface PageFocusTabs {
  title: string
  tabs: HeaderTab[]
  activeTabKey?: string
  activeFileId?: string
  favorites?: Set<string>
  onTabChange?: (key: string) => void
  onToggleFavorite?: (id: string) => void
  onCloseAllTabs?: () => void
}
