"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Check,
  ChevronDown,
  Copy,
  Database,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import { AmbySelect } from "@/components/ui/amby-select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { IconValue } from "@/components/workspace/icon-value"
import { cn } from "@/lib/utils"
import type { DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import { getViewLayoutIcon } from "./database-layout-icons"
import { DatabaseViewPicker } from "./database-view-picker"
import type { DatabaseViewChoice } from "./database-view-picker-model"
import { viewLabel, type LinkedView } from "./linked-block"

const ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"

/** The picker in a popover: the shortcut's "which database, shown how" choice. */
export function PickerPopover({
  current,
  onChoose,
  align = "start",
  children,
}: {
  current?: DatabaseViewChoice | null
  onChoose: (choice: DatabaseViewChoice) => void
  align?: "start" | "center" | "end"
  children: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-80 overflow-hidden p-0"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DatabaseViewPicker
          current={current}
          onCancel={() => setOpen(false)}
          onSelect={(choice) => {
            setOpen(false)
            onChoose(choice)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The tabs of a shortcut, drawn like the view tabs of a database. A tab shows
 * its own name and icon; hovering it names the database it looks at. Pressing
 * the tab that is already active opens its settings. With too little room all
 * of them fold into one button with the active view and a list, as in a database.
 */
export function LinkedTabs({
  views,
  databases,
  activeId,
  editable,
  collapsed,
  onSelect,
  onActivePress,
  onAdd,
  onRename,
  onEditView,
  onDuplicate,
  onDelete,
}: {
  views: LinkedView[]
  databases: DatabaseSummary[]
  activeId: string
  editable: boolean
  collapsed: boolean
  onSelect: (id: string) => void
  onActivePress: () => void
  onAdd: (choice: DatabaseViewChoice) => void
  onRename: () => void
  onEditView: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [addOpen, setAddOpen] = React.useState(false)

  if (collapsed) {
    const active = views.find((view) => view.id === activeId) ?? views[0]
    const database = databases.find((candidate) => candidate.databaseId === active.databaseId)
    const ActiveIcon = getViewLayoutIcon(active.layout)
    return (
      <div className="flex min-w-0 flex-1 items-center">
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverAnchor asChild>
            <div className="min-w-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title={database?.title ?? t("databaseLinkedView.missingTitle")}
                    aria-label={viewLabel(active, database?.title)}
                    className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-accent/70 px-3 text-xs font-medium text-foreground hover:bg-accent"
                  >
                    <IconValue
                      value={active.icon}
                      fallback={<ActiveIcon className="size-4 shrink-0" />}
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 max-w-[180px] truncate">
                      {viewLabel(active, database?.title)}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-56"
                  // Focus must not jump back to the button: the next panel takes it.
                  onCloseAutoFocus={(event) => event.preventDefault()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <DropdownMenuLabel>{t("databaseWorkspace.views")}</DropdownMenuLabel>
                  {views.map((view) => {
                    const viewDatabase = databases.find(
                      (candidate) => candidate.databaseId === view.databaseId,
                    )
                    const Icon = getViewLayoutIcon(view.layout)
                    const current = view.id === active.id
                    return (
                      <DropdownMenuItem
                        key={view.id}
                        onSelect={() => !current && onSelect(view.id)}
                        className={cn(current && "font-medium")}
                      >
                        <IconValue
                          value={view.icon}
                          fallback={<Icon className="size-4 shrink-0" />}
                          className="size-4 shrink-0"
                        />
                        <span className="flex-1 truncate">
                          {viewLabel(view, viewDatabase?.title)}
                        </span>
                        {current && <Check className="size-4 text-primary" />}
                      </DropdownMenuItem>
                    )
                  })}
                  {editable && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={onRename}>
                        <Pencil className="size-4" />
                        {t("databaseWorkspace.renameView")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={onEditView}>
                        <SlidersHorizontal className="size-4" />
                        {t("databaseWorkspace.editView")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={onDuplicate}>
                        <Copy className="size-4" />
                        {t("databaseWorkspace.duplicateView")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={views.length <= 1}
                        onSelect={onDelete}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        {t("databaseWorkspace.deleteView")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => window.setTimeout(() => setAddOpen(true), 60)}
                      >
                        <Plus className="size-4" />
                        {t("databaseWorkspace.addView")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            sideOffset={6}
            className="w-80 overflow-hidden p-0"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DatabaseViewPicker
              onCancel={() => setAddOpen(false)}
              onSelect={(choice) => {
                setAddOpen(false)
                onAdd(choice)
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div
        role="tablist"
        aria-label={t("databaseEmbed.views")}
        className="amby-tabs-scroll flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {views.map((view) => {
          const database = databases.find((candidate) => candidate.databaseId === view.databaseId)
          const active = view.id === activeId
          const LayoutIcon = getViewLayoutIcon(view.layout)
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={database?.title ?? t("databaseLinkedView.missingTitle")}
              onClick={() => (active ? editable && onActivePress() : onSelect(view.id))}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs",
                active
                  ? "bg-accent/70 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                !database && "opacity-60",
              )}
            >
              <IconValue
                value={view.icon}
                fallback={<LayoutIcon className="size-4 shrink-0" />}
                className="size-4 shrink-0"
              />
              <span className="max-w-[16rem] truncate">{viewLabel(view, database?.title)}</span>
            </button>
          )
        })}
      </div>
      {editable && (
        <PickerPopover onChoose={onAdd}>
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            aria-label={t("databaseEmbed.addView")}
            title={t("databaseEmbed.addView")}
          >
            <Plus className="size-4" />
          </button>
        </PickerPopover>
      )}
    </div>
  )
}

/**
 * The settings only a shortcut has, at the end of the view's settings: the
 * database it looks at (changeable) and, when the page is itself a database
 * row, the filter "linked to this page".
 */
export function LinkedViewExtras({
  database,
  onChooseSource,
}: {
  database: DatabaseSummary
  onChooseSource: (choice: DatabaseViewChoice) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="mt-0.5 space-y-1 border-t border-border/60 pt-1.5 pb-1.5">
      <PickerPopover onChoose={onChooseSource} align="end">
        <button type="button" className={ROW}>
          <Database className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("databaseEmbed.source")}</span>
          <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
            {database.title}
          </span>
        </button>
      </PickerPopover>
    </section>
  )
}

/**
 * "Linked to this page", part of the filter: when the page is itself a row of a
 * database, a relation of the shown database can be tied to it, so the view lists
 * only the records that belong to this page.
 */
export function PageFilterField({
  pageRelations,
  pageFilterProperty,
  onPageFilterChange,
}: {
  pageRelations: DatabasePropertySummary[]
  pageFilterProperty: string
  onPageFilterChange: (propertyId: string) => void
}) {
  const { t } = useTranslation()
  if (pageRelations.length === 0) return null
  return (
    <label className="block space-y-1.5 border-t border-border/60 pt-3">
      <span className="text-xs font-medium text-muted-foreground">
        {t("databaseEmbed.pageFilter")}
      </span>
      <AmbySelect
        size="sm"
        className="w-full"
        aria-label={t("databaseEmbed.pageFilter")}
        value={pageFilterProperty}
        options={[
          { value: "", label: t("databaseEmbed.pageFilterNone") },
          ...pageRelations.map((property) => ({
            value: property.propertyId,
            label: property.name,
          })),
        ]}
        onValueChange={onPageFilterChange}
      />
    </label>
  )
}
