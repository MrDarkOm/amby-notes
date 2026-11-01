import type * as React from "react"

/** Space before the icon of a top-level row, measured from the panel's own edge. */
export const TREE_BASE_INDENT = 14
/** One icon-sized branch step per nested level. */
export const TREE_LEVEL_STEP = 22

/**
 * The left inset of a row at `level`. The tree's rows and every panel section drawn beside it
 * (bookmarks, section headings) take it from here, so their icons and text share one column,
 * also in the compact density, which scales it through `--amby-density-padding-left`.
 */
export function treeRowInset(level = 0): number {
  return TREE_BASE_INDENT + level * TREE_LEVEL_STEP
}

export function treeRowInsetStyle(level = 0): React.CSSProperties {
  const paddingLeft = treeRowInset(level)
  return { paddingLeft, "--amby-density-padding-left": `${paddingLeft}px` } as React.CSSProperties
}
