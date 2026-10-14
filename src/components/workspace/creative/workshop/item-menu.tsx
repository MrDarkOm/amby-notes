import * as React from "react"
import { Check, ExternalLink, FileText, FolderInput, Pencil, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { TextStatusOptionSummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { ItemActionsContext } from "./item-actions"
import type { NotebookTarget } from "./notebook-model"

/**
 * Where a note can be moved from its menu: the notebooks to choose from and the root of the base
 * ("no notebook"). The place the note is in already is shown but cannot be chosen.
 */
export interface MoveMenu {
  targets: NotebookTarget[]
  /** The notebook the note is in; empty in the root. */
  current: readonly string[]
  onMove: (segments: string[] | null) => void
}

/**
 * The name of a page edited where it stands, as the file tree does it: Enter keeps the new name,
 * Escape and a click elsewhere with nothing changed leave the old one.
 */
export function InlineRename({
  title,
  indent,
  onCommit,
  onCancel,
}: {
  title: string
  /** Where the text starts, so the field sits under the row's own indentation. */
  indent: number
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(title)
  const done = React.useRef(false)
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const trimmed = name.trim()
    if (commit && trimmed && trimmed !== title) onCommit(trimmed)
    else onCancel()
  }
  return (
    <div className="px-1 py-0.5" style={{ paddingLeft: `${indent}px` }}>
      <input
        autoFocus
        value={name}
        maxLength={100}
        aria-label={t("creative.workshop.menu.rename")}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            finish(true)
          } else if (event.key === "Escape") {
            event.preventDefault()
            finish(false)
          }
          event.stopPropagation()
        }}
        className="w-full rounded border border-primary/50 bg-background px-1.5 py-0.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>
  )
}

/**
 * A row's own context menu. The row stops the event, so the menu of the empty space around it
 * does not open as well. `nested` are the pages below it: deleting the page takes them too, so
 * the menu says how many and asks for all of them in one confirmation.
 */
export function ItemMenu({
  noteId,
  title,
  nested = [],
  indent = 30,
  statusOptions,
  statusOptionId,
  onSelectStatus,
  move,
  children,
}: {
  noteId: string
  title: string
  /** Left offset of the row's text, for the inline rename field. */
  indent?: number
  /** IDs of the pages below this one, at any depth. */
  nested?: string[]
  /** Available page status options when the story has status configured. */
  statusOptions?: TextStatusOptionSummary[]
  /** Currently selected status option ID for this page. */
  statusOptionId?: string | null
  /** Sets or clears (`null`) the page's status option. */
  onSelectStatus?: (optionId: string | null) => void
  /** "Move to notebook": the keyboard-reachable way to what dragging does. */
  move?: MoveMenu
  /** The row; it receives the trigger's props. */
  children: React.ReactElement<{ onContextMenu?: React.MouseEventHandler }>
}) {
  const { t } = useTranslation()
  const actions = React.useContext(ItemActionsContext)
  const [renaming, setRenaming] = React.useState(false)
  if (!actions) return children
  const row = React.cloneElement(children, {
    onContextMenu: (event: React.MouseEvent) => {
      event.stopPropagation()
      children.props.onContextMenu?.(event)
    },
  })
  const canDeleteWithNested = nested.length > 0 && Boolean(actions.onDeleteMany)
  const remove = () => {
    if (canDeleteWithNested) void actions.onDeleteMany?.([noteId, ...nested])
    else void actions.onDelete?.(noteId)
  }
  const canDelete = nested.length > 0 ? canDeleteWithNested : Boolean(actions.onDelete)
  const hasStatusChoices =
    Boolean(onSelectStatus) && Boolean(statusOptions && statusOptions.length > 0)
  if (renaming && actions.onRename) {
    return (
      <InlineRename
        title={title}
        indent={indent}
        onCommit={(name) => {
          setRenaming(false)
          actions.onRename?.(noteId, name)
        }}
        onCancel={() => setRenaming(false)}
      />
    )
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-60 border-border bg-popover text-foreground">
          <ContextMenuItem className="gap-2 text-[13px]" onSelect={() => actions.onOpen(noteId)}>
            <FileText className="size-3.5 text-muted-foreground" />
            {t("creative.workshop.menu.open")}
          </ContextMenuItem>
          {actions.onOpenInNewTab && (
            <ContextMenuItem
              className="gap-2 text-[13px]"
              onSelect={() => actions.onOpenInNewTab?.(noteId)}
            >
              <ExternalLink className="size-3.5 text-muted-foreground" />
              {t("creative.workshop.menu.openInNewTab")}
            </ContextMenuItem>
          )}
          {actions.onRename && (
            <ContextMenuItem
              className="gap-2 text-[13px]"
              // The menu has to close before the field takes the focus.
              onSelect={() => window.setTimeout(() => setRenaming(true), 80)}
            >
              <Pencil className="size-3.5 text-muted-foreground" />
              {t("creative.workshop.menu.rename")}
            </ContextMenuItem>
          )}
          {move && (
            <ContextMenuSub>
              <ContextMenuSubTrigger className="gap-2 text-[13px]">
                <FolderInput className="size-3.5 text-muted-foreground" />
                {t("creative.notebooks.moveTo")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-72 w-60 overflow-y-auto border-border bg-popover text-foreground">
                {move.targets.map((target) => {
                  const here =
                    target.segments !== null &&
                    target.segments.length === move.current.length &&
                    target.segments.every((segment, index) => segment === move.current[index])
                  return (
                    <ContextMenuItem
                      key={target.label}
                      disabled={here}
                      className="gap-2 text-[13px]"
                      onSelect={() => move.onMove(target.segments)}
                    >
                      <span className="truncate" title={target.label}>
                        {target.segments?.[target.segments.length - 1]}
                      </span>
                      {target.depth > 0 && (
                        <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                          {target.segments?.slice(0, -1).join(" / ")}
                        </span>
                      )}
                    </ContextMenuItem>
                  )
                })}
                {move.targets.length > 0 && <ContextMenuSeparator />}
                <ContextMenuItem
                  disabled={move.current.length === 0}
                  className="gap-2 text-[13px]"
                  onSelect={() => move.onMove(null)}
                >
                  {t("creative.notebooks.root")}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {hasStatusChoices && statusOptions && onSelectStatus && (
            <>
              <ContextMenuSeparator />
              {statusOptions.map((option) => {
                const active = statusOptionId === option.id
                const dotClass =
                  option.group === "done"
                    ? "bg-emerald-500"
                    : option.group === "inProgress"
                      ? "bg-amber-500"
                      : "border border-muted-foreground/60"
                return (
                  <ContextMenuItem
                    key={option.id}
                    className="gap-2 text-[13px]"
                    onSelect={() => onSelectStatus(active ? null : option.id)}
                  >
                    <span aria-hidden="true" className={cn("size-2 rounded-full", dotClass)} />
                    <span className="flex-1 truncate">{option.name}</span>
                    {active && <Check className="size-3.5 text-primary" />}
                  </ContextMenuItem>
                )
              })}
            </>
          )}
          {canDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="gap-2 text-[13px] text-destructive focus:text-destructive"
                onSelect={remove}
              >
                <Trash2 className="size-3.5" />
                {nested.length > 0
                  ? t("creative.workshop.menu.deleteWithNested", { count: nested.length })
                  : t("creative.workshop.menu.delete")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </>
  )
}
