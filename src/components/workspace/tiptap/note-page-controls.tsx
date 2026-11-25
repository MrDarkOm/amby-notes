import * as React from "react"
import { createPortal } from "react-dom"
import { motion } from "motion/react"
import type { Editor } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import {
  Check,
  ChevronDown,
  DatabaseZap,
  FilePlus,
  LayoutList,
  PanelTop,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { confirmChoice } from "@/lib/confirm"
import { confirmations } from "@/lib/confirmations"
import { isEnterKey } from "@/lib/keyboard"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import type { NotePagesPref } from "../app-config"
import { HeadingHintsContext } from "../editor/heading-hints-context"
import { NotePagesDossierContext, NotePagesSlotContext } from "../editor/note-pages-context"
import { DatabaseViewPicker } from "../database/database-view-picker"
import type { DatabaseViewChoice } from "../database/database-view-picker-model"
import { useDatabaseStore } from "../database/database-store"
import { insertDatabaseView } from "./block-insert-items"
import { markEditorUserIntent } from "./editor-user-intent"
import {
  addNotePage,
  deleteNotePage,
  notePagesKey,
  notePagesPlugin,
  notePagesRule,
  renameNotePage,
  setNotePages,
} from "./note-pages"

/** The setting and the note's `amby-pages` flag that decide whether a note offers pages. */
export interface NotePagesSource {
  mode: NotePagesPref
  flag: boolean | null
}

const PILL =
  "h-9 max-w-60 flex-none gap-2 rounded-full border border-transparent px-3.5 text-[0.9375rem] font-medium"
// The open tab's background is a shared pill that slides between tabs (`layoutId`); the text colour follows
// `aria-selected`, because the context menu wrapper sets its own `data-state`.
const TAB =
  "relative isolate focus-visible:border-transparent focus-visible:outline-0 focus-visible:ring-0 text-muted-foreground hover:text-foreground aria-selected:text-foreground dark:text-muted-foreground dark:aria-selected:text-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none"

/** Whether the full row of tabs fits; otherwise they fold into the open page's menu. */
function useTabsFit(
  container: React.RefObject<HTMLDivElement | null>,
  measure: React.RefObject<HTMLDivElement | null>,
  count: number,
) {
  const [fits, setFits] = React.useState(true)
  React.useLayoutEffect(() => {
    const box = container.current
    const row = measure.current
    if (!box || !row) return
    const check = () => setFits(row.scrollWidth <= box.clientWidth)
    check()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(check)
    observer.observe(box)
    observer.observe(row)
    return () => observer.disconnect()
  }, [container, measure, count])
  return fits
}

/** The name of a page being edited in place of its tab: Enter or leaving keeps it, Esc does not. */
function PageNameField({
  initial,
  label,
  onDone,
}: {
  initial: string
  label: string
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = React.useState(initial)
  const done = React.useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  // An invisible copy of the text sizes the field, so it is as wide as the name it holds.
  return (
    <span className={cn(PILL, "inline-grid items-center bg-muted text-foreground")}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre">
        {value || " "}
      </span>
      <input
        aria-label={label}
        value={value}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (isEnterKey(event)) {
            event.preventDefault()
            finish(value)
          } else if (event.key === "Escape") {
            event.preventDefault()
            finish(null)
          }
        }}
        onBlur={() => finish(value)}
        size={1}
        className="col-start-1 row-start-1 w-full min-w-[3ch] bg-transparent outline-none"
      />
    </span>
  )
}

/** A title row narrower than this keeps the pages switch as an icon, so the title has room. */
const NARROW_TITLE_ROW = 480

function useNarrow(element: HTMLElement | null | undefined) {
  const [narrow, setNarrow] = React.useState(false)
  React.useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return
    const check = () => setNarrow(element.clientWidth > 0 && element.clientWidth < NARROW_TITLE_ROW)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return narrow
}

function preferenceKey(vault: string | undefined, note: string | undefined) {
  return note ? `amby:note-pages:v1:${JSON.stringify([vault ?? "", note])}` : null
}

export function NotePageControls({
  editor,
  source,
  noteId,
  vaultPath,
  paused,
  children,
}: {
  editor: Editor | null
  source: NotePagesSource
  noteId?: string
  vaultPath?: string
  paused: boolean
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const dossier = React.useContext(NotePagesDossierContext)
  const emptyLabel = t("docEditor.notePages.empty")
  const headingHints = React.useContext(HeadingHintsContext)
  const level = notePagesRule(source.mode, source.flag, dossier)
  const key = preferenceKey(vaultPath, noteId)
  const [override, setOverride] = React.useState<boolean | null>(() => {
    try {
      const value = key ? localStorage.getItem(key) : null
      return value === null ? null : value === "pages"
    } catch {
      return null
    }
  })
  const enabled = level !== null && (override ?? true)
  const subscribe = React.useCallback(
    (listener: () => void) => {
      if (!editor) return () => {}
      editor.on("transaction", listener)
      return () => {
        editor.off("transaction", listener)
      }
    },
    [editor],
  )
  const snapshot = React.useCallback(
    () => (editor ? (notePagesKey.getState(editor.state) ?? null) : null),
    [editor],
  )
  const control = React.useSyncExternalStore(subscribe, snapshot, () => null)

  React.useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || level === null) return
    editor.registerPlugin(notePagesPlugin(level, emptyLabel, headingHints), (plugin, plugins) => [
      plugin,
      ...plugins,
    ])
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(notePagesKey)
    }
  }, [editor, level, emptyLabel, headingHints])

  React.useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || level === null) return
    setNotePages(editor, enabled && !paused)
  }, [editor, enabled, level, paused])

  const toggle = () => {
    const next = !enabled
    setOverride(next)
    try {
      if (key) localStorage.setItem(key, next ? "pages" : "continuous")
    } catch {
      // The view still works if browser storage is unavailable.
    }
  }

  const active = level === null ? null : (control?.active ?? null)
  const pages = level === null ? [] : (control?.pages ?? [])
  const panelId = React.useId()
  const slot = React.useContext(NotePagesSlotContext)
  const stripRef = React.useRef<HTMLDivElement>(null)
  const measureRef = React.useRef<HTMLDivElement>(null)
  const shown = !paused && pages.length > 1
  const editable = Boolean(editor?.isEditable)
  const canAdd = editable && enabled && !paused && level !== null
  const [renaming, setRenaming] = React.useState<number | null>(null)
  /** The page just added from "+": Escape while naming it takes it back. */
  const created = React.useRef<number | null>(null)
  const [pickingView, setPickingView] = React.useState(false)
  const nameLabel = t("docEditor.notePages.nameField")
  const add = () => {
    if (!editor) return
    const name = t("docEditor.notePages.untitled", { number: pages.length + 1 })
    if (!addNotePage(editor, name)) return
    const added = notePagesKey.getState(editor.state)?.active
    if (added === null || added === undefined) return
    created.current = added
    // Open the name field once the menu has closed: its focus handling would blur and close the field.
    window.setTimeout(() => setRenaming(added), 0)
  }
  const addView = (choice: DatabaseViewChoice) => {
    setPickingView(false)
    if (!editor) return
    const database = useDatabaseStore
      .getState()
      .databases.find((candidate) => candidate.databaseId === choice.databaseId)
    const view = database?.views.find((candidate) => candidate.viewId === choice.viewId)
    const name =
      view?.title ||
      database?.title ||
      t("docEditor.notePages.untitled", { number: pages.length + 1 })
    if (!addNotePage(editor, name)) return
    markEditorUserIntent(editor)
    void insertDatabaseView(editor, choice)
  }
  const finishRename = (index: number, name: string | null) => {
    setRenaming(null)
    const fresh = created.current === index
    created.current = null
    if (!editor) return
    if (name === null && fresh) deleteNotePage(editor, index, false)
    else if (name !== null) renameNotePage(editor, index, name)
    editor.view.focus()
  }
  const canRename = (index: number) => editable && pages[index]?.title !== null
  const remove = async (index: number) => {
    const page = pages[index]
    if (!editor || !page) return
    const answer = await confirmChoice(confirmations.deleteNotePage({ name: title(page, index) }))
    if (answer === "yes") deleteNotePage(editor, index, false)
    else if (answer === "alternative") deleteNotePage(editor, index, true)
  }
  const fits = useTabsFit(stripRef, measureRef, active === null ? 0 : pages.length)
  const title = (page: (typeof pages)[number], index: number) =>
    page.title === null
      ? t("docEditor.notePages.introduction")
      : page.title || t("docEditor.notePages.untitled", { number: index + 1 })
  const select = (index: number) => {
    if (editor) setNotePages(editor, true, index)
  }
  const narrow = useNarrow(slot?.parentElement)
  const switchLabel = t(
    active !== null ? "docEditor.notePages.continuous" : "docEditor.notePages.show",
  )
  const switcher = shown ? (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="shrink-0"
      onClick={toggle}
      aria-label={narrow ? switchLabel : undefined}
      title={narrow ? switchLabel : undefined}
    >
      {active !== null ? <LayoutList aria-hidden="true" /> : <PanelTop aria-hidden="true" />}
      {narrow ? null : switchLabel}
    </Button>
  ) : null
  return (
    <div data-note-pages-active={active === null ? undefined : ""}>
      {slot && switcher ? createPortal(switcher, slot) : null}
      {((shown && (active !== null || !slot)) || (canAdd && pages.length < 2)) && (
        <div ref={stripRef} className="relative mb-4 flex min-w-0 items-center gap-2">
          {active !== null ? (
            <>
              {/* An invisible copy of the full row: its width decides whether the tabs fold. */}
              <div
                ref={measureRef}
                aria-hidden="true"
                className="pointer-events-none invisible absolute left-0 top-0 flex gap-1 whitespace-nowrap"
              >
                {pages.map((page, index) => (
                  <span key={index} className={cn(PILL, "inline-flex items-center")}>
                    <span className="truncate">{title(page, index)}</span>
                  </span>
                ))}
                {canAdd ? <span className="inline-flex size-9" /> : null}
              </div>
              {fits ? (
                <Tabs
                  value={String(active)}
                  className="min-w-0"
                  onValueChange={(value) => select(Number(value))}
                >
                  <TabsList
                    aria-label={t("docEditor.notePages.label")}
                    className="h-auto max-w-full flex-nowrap justify-start gap-1 rounded-none bg-transparent p-0"
                  >
                    {pages.map((page, index) =>
                      renaming === index ? (
                        <PageNameField
                          key={index}
                          initial={page.title ?? ""}
                          label={nameLabel}
                          onDone={(name) => finishRename(index, name)}
                        />
                      ) : (
                        <ContextMenu key={index}>
                          <ContextMenuTrigger asChild>
                            <TabsTrigger
                              id={`${panelId}-${index}`}
                              aria-controls={panelId}
                              value={String(index)}
                              className={cn(PILL, TAB)}
                            >
                              {index === active ? (
                                <motion.span
                                  layoutId={`${panelId}-pill`}
                                  aria-hidden="true"
                                  className="absolute inset-0 -z-10 rounded-full bg-muted"
                                  transition={motionTransitions.reorder}
                                />
                              ) : null}
                              <span className="truncate">{title(page, index)}</span>
                            </TabsTrigger>
                          </ContextMenuTrigger>
                          <ContextMenuContent
                            className="w-48"
                            // The rename field takes focus; returning it to the tab would close it.
                            onCloseAutoFocus={(event) => event.preventDefault()}
                          >
                            <ContextMenuItem
                              disabled={!canRename(index)}
                              onSelect={() => setRenaming(index)}
                            >
                              <Pencil className="size-4" />
                              {t("docEditor.notePages.rename")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              variant="destructive"
                              disabled={!editable}
                              onSelect={() => void remove(index)}
                            >
                              <Trash2 className="size-4" />
                              {t("docEditor.notePages.delete")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ),
                    )}
                  </TabsList>
                </Tabs>
              ) : renaming === active ? (
                <PageNameField
                  initial={pages[active].title ?? ""}
                  label={nameLabel}
                  onDone={(name) => finishRename(active, name)}
                />
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      id={`${panelId}-${active}`}
                      aria-label={`${t("docEditor.notePages.label")}: ${title(pages[active], active)}`}
                      className={cn(
                        PILL,
                        "inline-flex min-w-0 items-center bg-muted text-foreground hover:bg-muted/80",
                      )}
                    >
                      <span className="truncate">{title(pages[active], active)}</span>
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="max-h-80 w-64 overflow-y-auto"
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    {pages.map((page, index) => (
                      <DropdownMenuItem
                        key={index}
                        onSelect={() => select(index)}
                        className={cn(index === active && "font-medium")}
                      >
                        <span className="flex-1 truncate">{title(page, index)}</span>
                        {index === active && <Check className="size-4 text-primary" />}
                      </DropdownMenuItem>
                    ))}
                    {canRename(active) ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setRenaming(active)}>
                          <Pencil className="size-4" />
                          {t("docEditor.notePages.rename")}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {editable ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => void remove(active)}>
                        <Trash2 className="size-4" />
                        {t("docEditor.notePages.delete")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          ) : null}
          {canAdd ? (
            <Popover open={pickingView} onOpenChange={setPickingView}>
              <DropdownMenu>
                <PopoverAnchor asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-9 shrink-0 rounded-full text-muted-foreground"
                      aria-label={t("docEditor.notePages.addMenu")}
                      title={t("docEditor.notePages.addMenu")}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </PopoverAnchor>
                <DropdownMenuContent
                  align="start"
                  className="w-auto min-w-56"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenuItem onSelect={add}>
                    <FilePlus className="size-4" />
                    {t("docEditor.notePages.add")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPickingView(true)}>
                    <DatabaseZap className="size-4" />
                    {t("docEditor.notePages.addView")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <PopoverContent align="start" className="w-80 p-0">
                <DatabaseViewPicker onSelect={addView} onCancel={() => setPickingView(false)} />
              </PopoverContent>
            </Popover>
          ) : null}
          {slot ? null : switcher}
        </div>
      )}
      <div
        id={panelId}
        role={active === null ? undefined : "tabpanel"}
        aria-labelledby={active === null ? undefined : `${panelId}-${active}`}
        className="min-w-0"
      >
        {children}
      </div>
    </div>
  )
}
