import * as React from "react"

import type { PageCrumb } from "./page-chrome-types"

interface PageBreadcrumbsProps {
  crumbs: PageCrumb[]
  /** Shown as plain text when there are no crumbs yet. */
  fallbackTitle?: string
  /** True while the trail is shown whole (the header widens it on hover). */
  expanded?: boolean
  onExpandChange?: (expanded: boolean) => void
}

/** A trail longer than this folds its middle into "…" until the pointer rests on it. */
const FOLD_OVER = 4

/**
 * The breadcrumb of every page: a trail of crumbs, the last one the page itself. One markup for
 * a note's folders and for the steps of a workshop page.
 */
export function PageBreadcrumbs({
  crumbs,
  fallbackTitle,
  expanded = false,
  onExpandChange,
}: PageBreadcrumbsProps) {
  if (crumbs.length === 0) {
    return fallbackTitle ? (
      <span className="truncate text-muted-foreground">{fallbackTitle}</span>
    ) : null
  }
  const folded = !expanded && crumbs.length > FOLD_OVER
  const visible: (PageCrumb | "ellipsis")[] = folded
    ? [crumbs[0], "ellipsis", ...crumbs.slice(-2)]
    : crumbs
  return (
    <>
      {visible.map((crumb, idx) => {
        const isLast = idx === visible.length - 1
        if (crumb === "ellipsis") {
          return (
            <React.Fragment key="__ellipsis__">
              <span
                className="shrink-0 px-1 text-muted-foreground"
                title={crumbs
                  .slice(1, -2)
                  .map((item) => item.label)
                  .join(" › ")}
                onMouseEnter={() => onExpandChange?.(true)}
                onMouseLeave={() => onExpandChange?.(false)}
              >
                …
              </span>
              <span className="shrink-0 text-muted-foreground">›</span>
            </React.Fragment>
          )
        }
        const open = crumb.onOpen
        return (
          <React.Fragment key={crumb.key}>
            {!isLast && open ? (
              <button
                type="button"
                data-breadcrumb-segment
                className="max-w-[200px] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={open}
                title={crumb.label}
              >
                {crumb.icon ? (
                  <span className="mr-1 inline-flex align-middle">{crumb.icon}</span>
                ) : null}
                {crumb.label}
              </button>
            ) : (
              <span
                data-breadcrumb-segment
                className={`max-w-[260px] truncate px-1 ${isLast ? "inline-flex items-center gap-1 text-foreground" : "text-muted-foreground"}`}
                title={crumb.label}
              >
                {crumb.icon}
                {crumb.label}
              </span>
            )}
            {!isLast && <span className="shrink-0 text-muted-foreground">›</span>}
          </React.Fragment>
        )
      })}
    </>
  )
}
