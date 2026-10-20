import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { ChevronDown, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import { TabsMenu } from "../header-tabs"
import { handleDragStart } from "../editor/document-header-utils"
import { PageBreadcrumbs } from "./page-breadcrumbs"
import { PageMenu } from "./page-menu"
import type { PageCrumb, PageFocusTabs, PageMenuGroup } from "./page-chrome-types"

/** What the bar's own width allows: a narrow bar drops the path, then the focus button. */
export interface PageHeaderSize {
  isNarrow: boolean
  isUltraNarrow: boolean
  isTiny: boolean
}

export interface PageHeaderBarProps {
  /**
   * `docked`: the bar of a note, in the flow at the top of the surface. `floating`: laid over a
   * surface that has no room for it (the graph), with its buttons on small pills.
   */
  variant?: "docked" | "floating"
  crumbs: PageCrumb[]
  /** Plain text in place of the trail while there are no crumbs. */
  fallbackTitle?: string
  /** False leaves out Back and Forward (a page with no history to step through). */
  showHistory?: boolean
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  /** Names of the two buttons, for the surfaces that label them. */
  backLabel?: string
  forwardLabel?: string
  isFocusMode?: boolean
  onToggleFocusMode?: () => void
  hideFocusToggle?: boolean
  /** The tab menu that stands for the trail in focus mode. */
  focus?: PageFocusTabs
  /** Buttons before the focus toggle; a function gets the bar's width class. */
  leadingActions?: React.ReactNode | ((size: PageHeaderSize) => React.ReactNode)
  /** Buttons after the focus toggle, where the surface keeps a menu of its own. */
  trailingActions?: React.ReactNode
  /** The "⋯" menu, from the groups the surface supplies. */
  menu?: { groups: PageMenuGroup[]; open?: boolean; onOpenChange?: (open: boolean) => void }
}

const FLOATING_ROOT =
  "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-10 items-center justify-between px-2"
const FLOATING_PILL = "amby-graph-toolbar pointer-events-auto flex items-center gap-0.5 rounded-lg"

function FloatingHistoryButton({
  label,
  onClick,
  disabled,
  icon,
}: {
  label?: string
  onClick?: () => void
  disabled: boolean
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {icon}
    </button>
  )
}

/**
 * The header every page of the app wears: Back and Forward, the breadcrumb, the focus toggle and
 * the "⋯" menu. A note, the graph and a workshop page render it inside themselves, so it stays one
 * piece with the page; what differs is what they pass in.
 */
export function PageHeaderBar({
  variant = "docked",
  crumbs,
  fallbackTitle,
  showHistory = true,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  backLabel,
  forwardLabel,
  isFocusMode = false,
  onToggleFocusMode,
  hideFocusToggle = false,
  focus,
  leadingActions,
  trailingActions,
  menu,
}: PageHeaderBarProps) {
  const { t } = useTranslation()
  const [pathHovered, setPathHovered] = React.useState(false)
  const headerRef = React.useRef<HTMLDivElement>(null)
  const [headerWidth, setHeaderWidth] = React.useState(600)
  const floating = variant === "floating"

  React.useEffect(() => {
    const element = headerRef.current
    if (!element || floating) return

    const updateWidth = () => {
      setHeaderWidth(element.clientWidth)
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [floating])

  const size: PageHeaderSize = {
    isNarrow: !floating && headerWidth < 420,
    isUltraNarrow: !floating && headerWidth < 340,
    isTiny: !floating && headerWidth < 250,
  }

  const focusToggle = hideFocusToggle ? null : floating ? (
    <button
      type="button"
      title={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
      aria-label={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
      onClick={onToggleFocusMode}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {isFocusMode ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  ) : size.isTiny ? null : (
    <motion.button
      type="button"
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        isFocusMode && "bg-accent/60 text-foreground font-medium",
      )}
      onClick={onToggleFocusMode}
      title={isFocusMode ? t("docEditor.focusModeExit") : t("docEditor.focusModeEnter")}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={motionTransitions.fast}
    >
      {isFocusMode ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </motion.button>
  )

  const actions = typeof leadingActions === "function" ? leadingActions(size) : leadingActions
  const moreMenu = menu ? (
    <PageMenu groups={menu.groups} open={menu.open} onOpenChange={menu.onOpenChange} />
  ) : null

  if (floating) {
    return (
      <div ref={headerRef} className={FLOATING_ROOT}>
        {showHistory ? (
          <div className={FLOATING_PILL}>
            <FloatingHistoryButton
              label={backLabel}
              onClick={onBack}
              disabled={!canGoBack}
              icon={<ChevronLeft className="size-3.5" />}
            />
            <FloatingHistoryButton
              label={forwardLabel}
              onClick={onForward}
              disabled={!canGoForward}
              icon={<ChevronRight className="size-3.5" />}
            />
          </div>
        ) : (
          <span />
        )}
        {actions || focusToggle || trailingActions || moreMenu ? (
          <div className={FLOATING_PILL}>
            {actions}
            {focusToggle}
            {trailingActions}
            {moreMenu}
          </div>
        ) : null}
      </div>
    )
  }

  const breadcrumbElement = (
    <PageBreadcrumbs
      crumbs={crumbs}
      fallbackTitle={fallbackTitle}
      expanded={pathHovered}
      onExpandChange={setPathHovered}
    />
  )
  const fadedByPath = !isFocusMode && pathHovered

  return (
    <div
      ref={headerRef}
      className={`relative h-10 shrink-0 min-w-0 items-center px-2 ${
        isFocusMode
          ? "z-30 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] bg-transparent"
          : "flex justify-between bg-transparent"
      }`}
    >
      {/* Left: back/forward and, in focus mode, the path. */}
      <div className="flex min-w-0 shrink-0 items-center gap-0.5">
        {isFocusMode && <div className="h-10 w-6 cursor-default" onMouseDown={handleDragStart} />}
        {showHistory && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={`size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30 ${fadedByPath ? "pointer-events-none" : ""}`}
              animate={{ opacity: fadedByPath ? 0 : 1 }}
              transition={motionTransitions.default}
              onClick={onBack}
              disabled={!canGoBack}
              title={backLabel}
              aria-label={backLabel}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={`size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30 ${fadedByPath ? "pointer-events-none" : ""}`}
              animate={{ opacity: fadedByPath ? 0 : 1 }}
              transition={motionTransitions.default}
              onClick={onForward}
              disabled={!canGoForward}
              title={forwardLabel}
              aria-label={forwardLabel}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </>
        )}
        {isFocusMode && (
          <div className="ml-1 flex min-w-0 items-center gap-1 overflow-hidden text-xs">
            {breadcrumbElement}
          </div>
        )}
      </div>

      {/* Center: the tab menu in focus mode; the breadcrumb otherwise. */}
      <motion.div
        data-path-expanded={pathHovered || undefined}
        className={`flex min-w-0 flex-1 items-center justify-center gap-1 px-2 text-xs [&[data-path-expanded=true]_[data-breadcrumb-segment]]:max-w-none ${pathHovered ? "absolute inset-x-4 top-2 z-20 min-h-10 justify-start overflow-visible rounded-lg bg-white px-5 text-sm text-slate-900 shadow-lg ring-1 ring-slate-200" : size.isNarrow ? "hidden" : "overflow-hidden"}`}
        layout
        initial={false}
        animate={{ scale: pathHovered ? 1.01 : 1 }}
        transition={motionTransitions.slow}
        onMouseLeave={() => pathHovered && setPathHovered(false)}
      >
        {isFocusMode ? (
          <TabsMenu
            trigger={
              <button
                type="button"
                className="flex max-w-[320px] items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent"
                title={t("tabs.tabMenu")}
              >
                <span className="truncate">{focus?.title ?? ""}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            }
            tabs={focus?.tabs ?? []}
            activeTabKey={focus?.activeTabKey ?? ""}
            activeFileId={focus?.activeFileId}
            favorites={focus?.favorites}
            onTabChange={(key) => focus?.onTabChange?.(key)}
            onToggleFavorite={focus?.onToggleFavorite}
            onCloseAllTabs={focus?.onCloseAllTabs}
            align="center"
          />
        ) : (
          breadcrumbElement
        )}
      </motion.div>

      {/* Right: the surface's buttons, the focus toggle and the menu. */}
      <motion.div
        className={`flex shrink-0 items-center gap-0.5 ${isFocusMode ? "justify-self-end" : ""} ${fadedByPath ? "pointer-events-none" : ""}`}
        initial={false}
        animate={{ opacity: fadedByPath ? 0 : 1 }}
        transition={motionTransitions.default}
      >
        {actions}
        {focusToggle}
        {trailingActions}
        {moreMenu}
      </motion.div>
    </div>
  )
}
