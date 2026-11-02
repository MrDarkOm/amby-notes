import type { DatabaseSummary, DatabaseViewSummary } from "@/lib/storage"
import * as React from "react"

import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Reorder } from "motion/react"

import { cn } from "@/lib/utils"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { ViewIcon } from "./view-icon"

import { ViewTabItem, type ViewTabDrag } from "./view-tab-item"

interface DatabaseViewTabsProps {
  database: DatabaseSummary | undefined
  isCompactToolbar: boolean
  viewId: string | null
  viewDisplayModes: Record<string, "both" | "icon" | "text">
  databaseId: string
  activeViewMenuOpen: boolean
  setActiveViewMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSelectedViewId: (next: string | null) => void
  openViewSettings: (targetViewId: string, focusName: boolean) => void
  setViewDisplayMode: (targetViewId: string, mode: "both" | "icon" | "text") => void
  mutateView: (action: "duplicate" | "delete" | "default", targetViewId: string) => Promise<void>
  isDatabaseLocked: boolean
  vaultGeneration: number | null
  openCreateViewDialog: () => void
  tabViews: DatabaseViewSummary[]
  setViewOrder: React.Dispatch<React.SetStateAction<string[]>>
  persistViewOrder: () => Promise<void>
}

export function DatabaseViewTabs({
  database,
  isCompactToolbar,
  viewId,
  viewDisplayModes,
  databaseId,
  activeViewMenuOpen,
  setActiveViewMenuOpen,
  setSelectedViewId,
  openViewSettings,
  setViewDisplayMode,
  mutateView,
  isDatabaseLocked,
  vaultGeneration,
  openCreateViewDialog,
  tabViews,
  setViewOrder,
  persistViewOrder,
}: DatabaseViewTabsProps) {
  const { t } = useTranslation()
  return database && database.views.length > 0 ? (
    isCompactToolbar ? (
      (() => {
        const activeView =
          database.views.find((view) => view.viewId === viewId) ?? database.views[0]
        const activeViewDisplayMode =
          viewDisplayModes[`${databaseId}:${activeView.viewId}`] ?? "both"
        const showIcon = activeViewDisplayMode !== "text"
        const showText = activeViewDisplayMode !== "icon"

        return (
          <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu open={activeViewMenuOpen} onOpenChange={setActiveViewMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
                    "bg-slate-100 text-slate-900 hover:bg-slate-200/80 dark:bg-accent dark:text-foreground dark:hover:bg-accent/80",
                    activeViewDisplayMode === "icon" && "px-2.5",
                  )}
                  title={activeViewDisplayMode === "icon" ? activeView.title : undefined}
                  aria-label={activeView.title}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setActiveViewMenuOpen(true)
                  }}
                >
                  {showIcon && (
                    <ViewIcon
                      databaseId={databaseId}
                      viewId={activeView.viewId}
                      layout={activeView.layout}
                      className="size-4 shrink-0"
                    />
                  )}
                  {showText && (
                    <span className="truncate max-w-[120px] sm:max-w-[180px]">
                      {activeView.title}
                    </span>
                  )}
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-56"
                // Focus must not jump back to the tab: the settings panel takes it.
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                {database.views.length > 1 && (
                  <>
                    <DropdownMenuLabel>{t("databaseWorkspace.views")}</DropdownMenuLabel>
                    {database.views.map((v) => {
                      const isCurrent = v.viewId === activeView.viewId
                      return (
                        <DropdownMenuItem
                          key={v.viewId}
                          onSelect={() => setSelectedViewId(v.viewId)}
                          className={cn(isCurrent && "font-medium")}
                        >
                          <ViewIcon
                            databaseId={databaseId}
                            viewId={v.viewId}
                            layout={v.layout}
                            className="size-4 shrink-0"
                          />
                          <span className="flex-1 truncate">{v.title}</span>
                          {isCurrent && <Check className="size-4 text-primary" />}
                        </DropdownMenuItem>
                      )
                    })}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onSelect={() => openViewSettings(activeView.viewId, true)}>
                  <Pencil className="size-4" />
                  {t("databaseWorkspace.renameView")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openViewSettings(activeView.viewId, false)}>
                  <SlidersHorizontal className="size-4" />
                  {t("databaseWorkspace.editView")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Eye className="size-4" />
                    <span>{t("databaseWorkspace.viewDisplay")}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48">
                    <DropdownMenuItem
                      onSelect={() => setViewDisplayMode(activeView.viewId, "both")}
                    >
                      <span className="flex-1">
                        {t("databaseWorkspace.viewDisplayIconAndText")}
                      </span>
                      {activeViewDisplayMode === "both" && (
                        <Check className="size-4 text-primary" />
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setViewDisplayMode(activeView.viewId, "icon")}
                    >
                      <span className="flex-1">{t("databaseWorkspace.viewDisplayIconOnly")}</span>
                      {activeViewDisplayMode === "icon" && (
                        <Check className="size-4 text-primary" />
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setViewDisplayMode(activeView.viewId, "text")}
                    >
                      <span className="flex-1">{t("databaseWorkspace.viewDisplayTextOnly")}</span>
                      {activeViewDisplayMode === "text" && (
                        <Check className="size-4 text-primary" />
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onSelect={() => void mutateView("duplicate", activeView.viewId)}>
                  <Copy className="size-4" />
                  {t("databaseWorkspace.duplicateView")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={database.views.length <= 1}
                  onSelect={() => void mutateView("delete", activeView.viewId)}
                >
                  <Trash2 className="size-4" />
                  {t("databaseWorkspace.deleteView")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={isDatabaseLocked || vaultGeneration === null}
                  onSelect={openCreateViewDialog}
                >
                  <Plus className="size-4" />
                  {t("databaseWorkspace.addView")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })()
    ) : (
      <div className="group/views flex min-w-0 items-center gap-1">
        <Reorder.Group
          as="nav"
          axis="x"
          values={tabViews}
          onReorder={(next) => setViewOrder(next.map((view) => view.viewId))}
          aria-label={t("databaseWorkspace.views")}
          // No scrollbars: a dragged tab may overflow by a pixel, and the strip scrolls with the wheel.
          className="flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabViews.map((view) => {
            const isActive = view.viewId === viewId
            const viewDisplayMode = viewDisplayModes[`${databaseId}:${view.viewId}`] ?? "both"
            const showIcon = viewDisplayMode !== "text"
            const showText = viewDisplayMode !== "icon"

            const menuContent = (
              <DropdownMenuContent
                align="start"
                className="w-56"
                // Focus must not jump back to the tab: the settings panel takes it.
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                <DropdownMenuItem onSelect={() => openViewSettings(view.viewId, true)}>
                  <Pencil className="size-4" />
                  {t("databaseWorkspace.renameView")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openViewSettings(view.viewId, false)}>
                  <SlidersHorizontal className="size-4" />
                  {t("databaseWorkspace.editView")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Eye className="size-4" />
                    <span>{t("databaseWorkspace.viewDisplay")}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-48">
                    <DropdownMenuItem onSelect={() => setViewDisplayMode(view.viewId, "both")}>
                      <span className="flex-1">
                        {t("databaseWorkspace.viewDisplayIconAndText")}
                      </span>
                      {viewDisplayMode === "both" && <Check className="size-4 text-primary" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setViewDisplayMode(view.viewId, "icon")}>
                      <span className="flex-1">{t("databaseWorkspace.viewDisplayIconOnly")}</span>
                      {viewDisplayMode === "icon" && <Check className="size-4 text-primary" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setViewDisplayMode(view.viewId, "text")}>
                      <span className="flex-1">{t("databaseWorkspace.viewDisplayTextOnly")}</span>
                      {viewDisplayMode === "text" && <Check className="size-4 text-primary" />}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onSelect={() => void mutateView("duplicate", view.viewId)}>
                  <Copy className="size-4" />
                  {t("databaseWorkspace.duplicateView")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={database.views.length <= 1}
                  onSelect={() => void mutateView("delete", view.viewId)}
                >
                  <Trash2 className="size-4" />
                  {t("databaseWorkspace.deleteView")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={isDatabaseLocked || vaultGeneration === null}
                  onSelect={openCreateViewDialog}
                >
                  <Plus className="size-4" />
                  {t("databaseWorkspace.addView")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            )

            const renderTab = (drag: ViewTabDrag) => {
              if (isActive) {
                return (
                  <DropdownMenu open={activeViewMenuOpen} onOpenChange={setActiveViewMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
                          "bg-slate-100 text-slate-900 hover:bg-slate-200/80 dark:bg-accent dark:text-foreground dark:hover:bg-accent/80",
                          viewDisplayMode === "icon" && "px-2.5",
                        )}
                        title={viewDisplayMode === "icon" ? view.title : undefined}
                        aria-label={view.title}
                        // A press that moves drags the tab; a plain click opens the menu.
                        onPointerDown={(event) => {
                          event.preventDefault()
                          drag.startWatch(event)
                        }}
                        onClick={() => {
                          if (!drag.consumeClick()) setActiveViewMenuOpen((open) => !open)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setActiveViewMenuOpen(true)
                        }}
                      >
                        {showIcon && (
                          <ViewIcon
                            databaseId={databaseId}
                            viewId={view.viewId}
                            layout={view.layout}
                            className="size-4 shrink-0"
                          />
                        )}
                        {showText && <span>{view.title}</span>}
                      </button>
                    </DropdownMenuTrigger>
                    {menuContent}
                  </DropdownMenu>
                )
              }

              return (
                <button
                  key={view.viewId}
                  type="button"
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs",
                    "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-accent/50 dark:hover:text-foreground",
                    viewDisplayMode === "icon" && "px-2.5",
                  )}
                  title={viewDisplayMode === "icon" ? view.title : undefined}
                  aria-label={view.title}
                  onPointerDown={drag.startWatch}
                  onClick={() => {
                    if (!drag.consumeClick()) setSelectedViewId(view.viewId)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setSelectedViewId(view.viewId)
                    setActiveViewMenuOpen(true)
                  }}
                >
                  {showIcon && (
                    <ViewIcon
                      databaseId={databaseId}
                      viewId={view.viewId}
                      layout={view.layout}
                      className="size-4 shrink-0"
                    />
                  )}
                  {showText && <span>{view.title}</span>}
                </button>
              )
            }
            return (
              <ViewTabItem
                key={view.viewId}
                value={view}
                disabled={isDatabaseLocked || vaultGeneration === null}
                onDropped={persistViewOrder}
              >
                {renderTab}
              </ViewTabItem>
            )
          })}
        </Reorder.Group>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-slate-500 opacity-0 group-hover/views:opacity-100 focus-visible:opacity-100 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-accent/50"
          aria-label={t("databaseWorkspace.addView")}
          title={t("databaseWorkspace.addView")}
          disabled={isDatabaseLocked || vaultGeneration === null}
          onClick={openCreateViewDialog}
        >
          <Plus className="size-4" />
        </button>
      </div>
    )
  ) : (
    <div />
  )
}
