import * as React from "react"
import {
  AppWindow,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderInput,
  GripVertical,
  Link2,
  Search,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  Star,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import type { DatabaseRow, DatabaseSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { OpenModeIcon } from "./open-mode-icon"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "../tiptap/floating-menu-events"
import { useViewStateStore } from "../use-view-state-store"
import { InlinePickers } from "./inline-pickers"
import { PageIcon } from "./page-icon"
import { closeFloatingMenus } from "./close-floating-menus"
import { watchBlockedDrag } from "./layouts/use-row-reorder"

/** What the row menu can do. An action that is absent is not offered. */
export interface RowMenuModel {
  isFavorite: boolean
  /** How the view opens a row; the first choice of "Open" follows it. */
  openMode: string
  currentDatabaseId: string
  /** Databases a row can be moved to. */
  databases: DatabaseSummary[]
  onToggleFavorite?: () => void
  /** Opens the row the way the view does. */
  onOpen: () => void
  onOpenInNewTab?: () => void
  onOpenInNewWindow?: () => void
  onRename?: (name: string) => Promise<void> | void
  onCopyLink?: () => void
  onDuplicate?: () => Promise<void> | void
  onMoveTo?: (databaseId: string) => Promise<void> | void
  onDelete?: () => void
  /** The row's properties as editors; the "Properties" page is left out without it. */
  renderProperties?: () => React.ReactNode
}

type Page = "main" | "open" | "move" | "properties" | "icon"

const ITEM =
  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"

interface RowGrabProps {
  row: DatabaseRow
  menu: RowMenuModel
  /** False while a sort decides the order: the grip then only opens the menu. */
  reorderEnabled: boolean
  /** The press of the grip: starts a drag, and calls `onClick` when it was only a click. */
  onPress: (
    event: React.PointerEvent<HTMLElement>,
    rowId: string,
    options: { lift: HTMLElement; onClick: () => void },
  ) => void
  /** Moves the row one place with the arrow keys on the grip. */
  onNudge?: (offset: -1 | 1) => void
  /** Called when the grip is dragged while a sort forbids it. */
  onBlockedDrag?: () => void
  /** The row's element, when the grip does not sit inside it (a grip beside the table). */
  liftTo?: () => HTMLElement | null
  /** Drawn faint until the row is hovered; stays solid while its menu is open or it has focus. */
  faded?: boolean
  className?: string
}

/**
 * The grip of a row: drag it to place the row where you want it, press it to open the row's
 * menu. The grip is a button, so the keyboard opens the menu and the arrow keys move the row.
 */
export function RowGrab({
  row,
  menu,
  reorderEnabled,
  onPress,
  onNudge,
  onBlockedDrag,
  liftTo,
  faded = false,
  className,
}: RowGrabProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const blocked = React.useRef(false)
  const openMenu = () => {
    closeFloatingMenus()
    setOpen(true)
  }
  const label = reorderEnabled ? t("databaseRowMenu.grab") : t("databaseRowMenu.grabSorted")
  return (
    <RowMenuPopover
      open={open}
      onOpenChange={setOpen}
      row={row}
      menu={menu}
      anchor={
        <PopoverAnchor asChild>
          <button
            type="button"
            aria-label={label}
            title={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-no-drag=""
            style={{ touchAction: "none" }}
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
              reorderEnabled ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
              open && "bg-accent text-foreground",
              faded && !open && "opacity-0",
              className,
            )}
            onPointerDown={(event) => {
              // The press is left to bubble so that any other open menu sees it and closes.
              if (!reorderEnabled) {
                if (onBlockedDrag) {
                  blocked.current = false
                  watchBlockedDrag(event, () => {
                    blocked.current = true
                    onBlockedDrag()
                  })
                }
                return
              }
              onPress(event, row.noteId, {
                lift: (liftTo?.() ??
                  event.currentTarget.closest("[data-reorder-id]") ??
                  event.currentTarget) as HTMLElement,
                onClick: openMenu,
              })
            }}
            onClick={(event) => {
              event.stopPropagation()
              // The click that ends a refused drag is not a request for the menu.
              if (blocked.current) {
                blocked.current = false
                return
              }
              // A mouse press is handled by the pointer logic; this is the keyboard, or no drag.
              if (!reorderEnabled || event.detail === 0) openMenu()
            }}
            onKeyDown={(event) => {
              if (!reorderEnabled || !onNudge) return
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
              event.preventDefault()
              event.stopPropagation()
              onNudge(event.key === "ArrowUp" ? -1 : 1)
            }}
          >
            <GripVertical className="size-4" />
          </button>
        </PopoverAnchor>
      }
    />
  )
}

/** The row's menu, shown at `anchor`: the grip, or the point of a right click. */
export function RowMenuPopover({
  open,
  onOpenChange,
  row,
  menu,
  anchor,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: DatabaseRow
  menu: RowMenuModel
  anchor: React.ReactNode
}) {
  // Another menu opening (or an icon picker) closes this one: only one is open at a time.
  React.useEffect(() => {
    if (!open) return
    const close = () => onOpenChange(false)
    window.addEventListener(CLOSE_EDITOR_MENUS_EVENT, close)
    window.addEventListener(CLOSE_BLOCK_MENUS_EVENT, close)
    return () => {
      window.removeEventListener(CLOSE_EDITOR_MENUS_EVENT, close)
      window.removeEventListener(CLOSE_BLOCK_MENUS_EVENT, close)
    }
  }, [onOpenChange, open])
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="w-auto p-1.5"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {open && <RowMenuPages row={row} menu={menu} close={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  )
}

function RowMenuPages({
  row,
  menu,
  close,
}: {
  row: DatabaseRow
  menu: RowMenuModel
  close: () => void
}) {
  const { t } = useTranslation()
  const [page, setPage] = React.useState<Page>("main")
  const [busy, setBusy] = React.useState(false)

  // A choice closes the menu; one that takes time keeps it open and inert until it is done.
  async function run(action?: () => Promise<void> | void) {
    if (!action || busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      close()
    }
  }

  if (page === "icon") {
    return (
      <PageShell title={t("databaseRowMenu.icon")} onBack={() => setPage("main")} width="w-[352px]">
        <IconPage noteId={row.noteId} done={() => setPage("main")} />
      </PageShell>
    )
  }
  if (page === "properties" && menu.renderProperties) {
    return (
      <PageShell title={t("databaseRowMenu.properties")} onBack={() => setPage("main")}>
        {/* Pickers unfold in place: a menu is never opened over another menu. */}
        <InlinePickers value>
          <div className="max-h-80 overflow-y-auto px-1 pb-1">{menu.renderProperties()}</div>
        </InlinePickers>
      </PageShell>
    )
  }
  if (page === "open") {
    const modeLabel =
      menu.openMode === "centerPeek"
        ? t("databaseRowMenu.openCenter")
        : menu.openMode === "fullPage"
          ? t("databaseRowMenu.openFullPage")
          : t("databaseRowMenu.openSide")
    return (
      <PageShell title={t("databaseRowMenu.open")} onBack={() => setPage("main")}>
        <button type="button" className={ITEM} onClick={() => void run(menu.onOpen)}>
          <OpenModeIcon mode={menu.openMode} />
          <span className="flex-1 truncate">{modeLabel}</span>
          <span className="text-[11px] text-muted-foreground">{t("databaseRowMenu.asInView")}</span>
        </button>
        {menu.onOpenInNewTab && (
          <button type="button" className={ITEM} onClick={() => void run(menu.onOpenInNewTab)}>
            <SquareArrowOutUpRight className="size-3.5 text-muted-foreground" />
            {t("databaseRowMenu.openNewTab")}
          </button>
        )}
        {menu.onOpenInNewWindow && (
          <button type="button" className={ITEM} onClick={() => void run(menu.onOpenInNewWindow)}>
            <AppWindow className="size-3.5 text-muted-foreground" />
            {t("databaseRowMenu.openNewWindow")}
          </button>
        )}
      </PageShell>
    )
  }
  if (page === "move" && menu.onMoveTo) {
    return (
      <MovePage
        databases={menu.databases}
        currentDatabaseId={menu.currentDatabaseId}
        busy={busy}
        onBack={() => setPage("main")}
        onPick={(databaseId) => void run(() => menu.onMoveTo?.(databaseId))}
      />
    )
  }

  return (
    <div className="flex w-72 flex-col gap-0.5">
      <RowHeader row={row} onRename={menu.onRename} onPickIcon={() => setPage("icon")} />
      <Separator />
      {menu.onToggleFavorite && (
        <button type="button" className={ITEM} onClick={() => void run(menu.onToggleFavorite)}>
          <Star
            className={cn(
              "size-3.5",
              menu.isFavorite ? "fill-current text-primary" : "text-muted-foreground",
            )}
          />
          {menu.isFavorite ? t("databaseRowMenu.removeFavorite") : t("databaseRowMenu.addFavorite")}
        </button>
      )}
      {menu.renderProperties && (
        <button type="button" className={ITEM} onClick={() => setPage("properties")}>
          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
          <span className="flex-1">{t("databaseRowMenu.properties")}</span>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      )}
      <button type="button" className={ITEM} onClick={() => setPage("open")}>
        <OpenModeIcon mode={menu.openMode} />
        <span className="flex-1">{t("databaseRowMenu.open")}</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </button>
      <Separator />
      {menu.onCopyLink && (
        <button type="button" className={ITEM} onClick={() => void run(menu.onCopyLink)}>
          <Link2 className="size-3.5 text-muted-foreground" />
          {t("databaseRowMenu.copyLink")}
        </button>
      )}
      {menu.onDuplicate && (
        <button
          type="button"
          className={ITEM}
          disabled={busy}
          onClick={() => void run(menu.onDuplicate)}
        >
          <Copy className="size-3.5 text-muted-foreground" />
          {t("databaseRowMenu.duplicate")}
        </button>
      )}
      {menu.onMoveTo && (
        <button type="button" className={ITEM} onClick={() => setPage("move")}>
          <FolderInput className="size-3.5 text-muted-foreground" />
          <span className="flex-1">{t("databaseRowMenu.moveTo")}</span>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      )}
      {menu.onDelete && (
        <button
          type="button"
          className={cn(ITEM, "text-destructive hover:text-destructive")}
          onClick={() => void run(menu.onDelete)}
        >
          <Trash2 className="size-3.5" />
          {t("databaseRowMenu.delete")}
        </button>
      )}
    </div>
  )
}

function Separator() {
  return <div role="separator" className="-mx-1.5 my-1 h-px bg-border" />
}

function PageShell({
  title,
  onBack,
  width = "w-72",
  children,
}: {
  title: string
  onBack: () => void
  width?: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className={cn("flex flex-col gap-0.5", width)}>
      <div className="flex items-center gap-1 px-0.5 pb-1">
        <button
          type="button"
          aria-label={t("databaseRowMenu.back")}
          title={t("databaseRowMenu.back")}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  )
}

/** The row's icon and name, both changed on the spot. */
function RowHeader({
  row,
  onRename,
  onPickIcon,
}: {
  row: DatabaseRow
  onRename?: (name: string) => Promise<void> | void
  onPickIcon: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(row.title)
  // A rename done elsewhere (or this one, once saved) shows up without leaving the menu.
  React.useEffect(() => setName(row.title), [row.title])
  const commit = () => {
    const next = name.trim()
    if (!next || next === row.title) {
      setName(row.title)
      return
    }
    void Promise.resolve(onRename?.(next)).catch(() => setName(row.title))
  }
  return (
    <div className="flex items-center gap-1.5 px-0.5 py-1">
      <button
        type="button"
        aria-label={t("databaseCard.changeIcon")}
        title={t("databaseCard.changeIcon")}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-muted/40 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onPickIcon}
      >
        <PageIcon noteId={row.noteId} />
      </button>
      <input
        value={name}
        disabled={!onRename}
        aria-label={t("databaseRowMenu.name")}
        placeholder={t("databaseRowMenu.name")}
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2.5 text-[13px] font-medium outline-none hover:bg-muted/70 focus:border-ring focus:bg-background disabled:opacity-70"
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === "Escape") {
            event.stopPropagation()
            setName(row.title)
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

/** The icon picker inside the menu itself; choosing one returns to the menu. */
function IconPage({ noteId, done }: { noteId: string; done: () => void }) {
  const { t } = useTranslation()
  const setIcon = useViewStateStore((state) => state.setIcon)
  return (
    <EmojiPickerPanel
      onSelect={(emoji) => {
        setIcon(noteId, emoji.native)
        done()
      }}
      onClear={() => {
        setIcon(noteId, "")
        done()
      }}
      clearLabel={t("tree.resetIcon")}
      onClose={done}
    />
  )
}

function MovePage({
  databases,
  currentDatabaseId,
  busy,
  onBack,
  onPick,
}: {
  databases: DatabaseSummary[]
  currentDatabaseId: string
  busy: boolean
  onBack: () => void
  onPick: (databaseId: string) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const targets = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return databases
      .filter((database) => database.databaseId !== currentDatabaseId && !database.locked)
      .filter((database) => !needle || database.title.toLocaleLowerCase().includes(needle))
  }, [currentDatabaseId, databases, query])
  return (
    <PageShell title={t("databaseRowMenu.moveTo")} onBack={onBack}>
      <div className="relative px-0.5 pb-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          placeholder={t("databaseRowMenu.searchDatabases")}
          aria-label={t("databaseRowMenu.searchDatabases")}
          className="amby-inset-icon-input h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-2 text-[13px] outline-none focus:border-ring"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {targets.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            {t("databaseRowMenu.noDatabases")}
          </p>
        ) : (
          targets.map((database) => (
            <button
              key={database.databaseId}
              type="button"
              disabled={busy}
              className={ITEM}
              onClick={() => onPick(database.databaseId)}
            >
              <span className="truncate">{database.title}</span>
            </button>
          ))
        )}
      </div>
    </PageShell>
  )
}
