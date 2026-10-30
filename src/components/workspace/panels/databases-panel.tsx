import * as React from "react"
import {
  AlertTriangle,
  ChevronDown,
  Database,
  Ellipsis,
  FileText,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { ViewIcon } from "../database/view-icon"
import { MotionSpinner } from "@/lib/motion"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { buildBreadcrumb } from "../editor/document-breadcrumbs-utils"
import { findTreeItem } from "../workspace-tree-utils"
import { IconValue } from "../icon-value"
import { PanelHeader, PanelSearch } from "./panel-header"

// Titles are labels; only IDs identify databases. Retain all other diagnostics.
const relevantDiagnostics = <T extends { code: string }>(items: T[]) =>
  items.filter((item) => item.code.toLowerCase() !== "duplicatedatabasetitle")

function DiagnosticHint({ message }: { message: string }) {
  const [open, setOpen] = React.useState(false)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const pinned = React.useRef(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enter = () => {
    clearTimeout(timer.current)
    setOpen(true)
  }
  const leave = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!pinned.current) setOpen(false)
    }, 150)
  }
  const close = () => {
    pinned.current = false
    setOpen(false)
  }
  React.useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <PopoverAnchor asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon-sm"
          aria-label={message}
          aria-expanded={open}
          aria-haspopup="dialog"
          whileTap={undefined}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={() => {
            clearTimeout(timer.current)
            if (pinned.current) close()
            else {
              pinned.current = true
              setOpen(true)
            }
          }}
        >
          <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-500" />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="whitespace-pre-line break-words text-xs"
        onInteractOutside={(event) => {
          if (event.target instanceof Node && trigger.current?.contains(event.target))
            event.preventDefault()
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        {message}
      </PopoverContent>
    </Popover>
  )
}

export function DatabasesPanel({
  databaseRuntimeEnabled,
  onOpenDatabase,
  onSelect,
  treeItems,
  selectedId,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const status = useDatabaseStore((state) => state.catalogStatus)
  const databases = useDatabaseStore((state) => state.databases)
  const diagnostics = useDatabaseStore((state) => state.diagnostics)
  const visibleDiagnostics = relevantDiagnostics(diagnostics)
  const error = useDatabaseStore((state) => state.error)
  const [query, setQuery] = React.useState("")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = React.useMemo(
    () =>
      databases.map((database) => {
        const note = database.attachedNoteId
          ? findTreeItem(treeItems, database.attachedNoteId)
          : null
        const item = note ?? findTreeItem(treeItems, database.databaseId)
        const location = item
          ? buildBreadcrumb(treeItems, item.id)
              .map((segment) => segment.name)
              .join(" / ")
          : ""
        return { database, item, location, warnings: relevantDiagnostics(database.diagnostics) }
      }),
    [databases, treeItems],
  )
  const visibleDatabases = entries.filter(({ database, location }) =>
    `${database.title} ${location}`.toLocaleLowerCase().includes(normalizedQuery),
  )
  const diagnosticTooltip = (items: typeof diagnostics) =>
    [
      ...(items.length > 1 ? [t("databasePanel.diagnostics", { count: items.length })] : []),
      ...items.map((item) => item.message),
    ].join("\n")

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PanelHeader
        title={t("panels.databases")}
        actions={
          <>
            {visibleDiagnostics.length > 0 && (
              <DiagnosticHint message={diagnosticTooltip(visibleDiagnostics)} />
            )}
            <span className="text-[10px] font-normal text-muted-foreground">
              {status === "ready" ? databases.length : t(`databasePanel.status.${status}`)}
            </span>
          </>
        }
      />
      {databaseRuntimeEnabled && databases.length > 0 && (
        <PanelSearch
          value={query}
          onChange={setQuery}
          ariaLabel={t("databasePanel.search")}
          placeholder={t("databasePanel.search")}
        />
      )}
      {!databaseRuntimeEnabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <Database className="size-7 text-muted-foreground" />
          <p className="text-xs font-medium">{t("databasePanel.disabledTitle")}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("databasePanel.disabledDescription")}
          </p>
        </div>
      ) : status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <MotionSpinner>
            <Loader2 className="size-4" />
          </MotionSpinner>
        </div>
      ) : status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
          <AlertTriangle className="size-7 text-amber-600 dark:text-amber-500" />
          <p className="text-xs font-medium">{t("databasePanel.loadFailed")}</p>
          <p className="break-words text-[11px] text-muted-foreground">{error}</p>
        </div>
      ) : databases.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <RefreshCw className="size-7 text-muted-foreground" />
          <p className="text-xs font-medium">{t("databasePanel.empty")}</p>
          <p className="text-[11px] text-muted-foreground">{t("databasePanel.emptyHint")}</p>
        </div>
      ) : visibleDatabases.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center">
          <p className="text-[11px] text-muted-foreground">{t("databasePanel.noResults")}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="space-y-1">
            {visibleDatabases.map(({ database, item, location, warnings }) => (
              <div
                key={database.databaseId}
                className="flex items-center gap-1 rounded-md hover:bg-accent/40 has-[[aria-current=page]]:bg-accent/40"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left"
                  aria-current={item?.id === selectedId ? "page" : undefined}
                  onClick={() => onOpenDatabase?.(database.databaseId, database.title)}
                >
                  <IconValue
                    value={database.icon ?? undefined}
                    className="mt-0.5 size-4 shrink-0"
                    fallback={<Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block whitespace-normal break-words text-xs leading-4 [overflow-wrap:anywhere]">
                      {database.title}
                    </span>
                    <span
                      className="block whitespace-normal break-words text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]"
                      title={location || undefined}
                    >
                      {location || t("databasePanel.locationUnavailable")}
                    </span>
                  </span>
                </button>
                {database.views.length > 1 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t("databasePanel.chooseView")}
                        aria-label={t("databasePanel.chooseView")}
                      >
                        <ChevronDown className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {database.views.map((view) => (
                        <DropdownMenuItem
                          key={view.viewId}
                          onSelect={() => {
                            useDatabaseStore
                              .getState()
                              .requestView(database.databaseId, view.viewId)
                            onOpenDatabase?.(database.databaseId, database.title)
                          }}
                        >
                          <ViewIcon
                            databaseId={database.databaseId}
                            viewId={view.viewId}
                            layout={view.layout}
                            className="size-3.5"
                          />
                          {view.title}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t("databasePanel.actions")}
                      aria-label={t("databasePanel.actions")}
                    >
                      <Ellipsis className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => onOpenDatabase?.(database.databaseId, database.title)}
                    >
                      {t("databasePanel.open")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onOpenDatabase?.(database.databaseId, database.title, true)}
                    >
                      {t("databasePanel.openNewTab")}
                    </DropdownMenuItem>
                    {database.attachedNoteId && item && (
                      <DropdownMenuItem onSelect={() => onSelect(item.id)}>
                        <FileText className="size-3.5" />
                        {t("databasePanel.openNote")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                {warnings.length > 0 && <DiagnosticHint message={diagnosticTooltip(warnings)} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
