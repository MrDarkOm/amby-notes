import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import type { Editor } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import {
  Check,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  DatabaseZap,
  FilePlus,
  GripVertical,
  FileOutput,
  LayoutList,
  Link2,
  PanelTop,
  Pencil,
  Plus,
  Search,
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
import { logger } from "@/lib/logger"
import { motionTransitions } from "@/lib/motion-config"
import { cn } from "@/lib/utils"
import type { NotePagesPref } from "../app-config"
import { toRelativeVaultPath } from "../workspace-tree-utils"
import { NotePagesDossierContext, NotePagesSlotContext } from "../editor/note-pages-context"
import { DatabaseViewPicker } from "../database/database-view-picker"
import type { DatabaseViewChoice } from "../database/database-view-picker-model"
import { useDatabaseStore } from "../database/database-store"
import { insertDatabaseView } from "./block-insert-items"
import { markEditorUserIntent } from "./editor-user-intent"
import { ExtractNotePageDialog, NotePagePicker } from "./note-page-dialogs"
import { useNotePageDrag } from "./use-note-page-drag"
import {
  addNotePage,
  deleteNotePage,
  extractNotePage,
  moveNotePage,
  notePageExtraction,
  notePageIdentity,
  notePagesKey,
  notePagesPlugin,
  notePagesRule,
  renameNotePage,
  restoreNotePageIndex,
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
  notePath,
  vaultPath,
  children,
}: {
  editor: Editor | null
  source: NotePagesSource
  noteId?: string
  notePath?: string
  vaultPath?: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const dossier = React.useContext(NotePagesDossierContext)
  const emptyLabel = t("docEditor.notePages.empty")
  const level = notePagesRule(source.mode, source.flag, dossier)
  const key = preferenceKey(vaultPath, noteId)
  const activeKey = key ? `${key}:active` : null
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
  const selection = React.useSyncExternalStore(subscribe, () => editor?.state.selection)
  const restoredFor = React.useRef<{ editor: Editor; key: string | null } | null>(null)

  React.useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || level === null) return
    editor.registerPlugin(notePagesPlugin(level, emptyLabel), (plugin, plugins) => [
      plugin,
      ...plugins,
    ])
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false))
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(notePagesKey)
    }
  }, [editor, level, emptyLabel])

  React.useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || level === null) return
    let index: number | undefined
    if (
      enabled &&
      (restoredFor.current?.editor !== editor || restoredFor.current.key !== activeKey)
    ) {
      restoredFor.current = { editor, key: activeKey }
      try {
        const identity = activeKey ? localStorage.getItem(activeKey) : null
        const state = notePagesKey.getState(editor.state)
        if (identity !== null && state) index = restoreNotePageIndex(state.pages, identity)
      } catch {
        // The view still works if browser storage is unavailable.
      }
    }
    setNotePages(editor, enabled, index)
  }, [editor, enabled, level, emptyLabel, activeKey])

  const active = level === null ? null : (control?.active ?? null)
  const pages = level === null ? [] : (control?.pages ?? [])
  const activeIdentity = active === null ? null : notePageIdentity(pages, active)
  React.useEffect(() => {
    if (activeKey === null || activeIdentity === null) return
    try {
      localStorage.setItem(activeKey, activeIdentity)
    } catch {
      // The view still works if browser storage is unavailable.
    }
  }, [activeKey, activeIdentity])

  const toggle = () => {
    const next = !enabled
    setOverride(next)
    try {
      if (key) localStorage.setItem(key, next ? "pages" : "continuous")
    } catch {
      // The view still works if browser storage is unavailable.
    }
  }

  const panelId = React.useId()
  const slot = React.useContext(NotePagesSlotContext)
  const stripRef = React.useRef<HTMLDivElement>(null)
  const measureRef = React.useRef<HTMLDivElement>(null)
  const shown = pages.length > 1
  const editable = Boolean(editor?.isEditable)
  const canAdd = editable && enabled && level !== null
  const [renaming, setRenaming] = React.useState<number | null>(null)
  /** The page just added from "+": Escape while naming it takes it back. */
  const created = React.useRef<number | null>(null)
  const [pickingView, setPickingView] = React.useState(false)
  const [pickingPage, setPickingPage] = React.useState(false)
  const [extracting, setExtracting] = React.useState<ReturnType<typeof notePageExtraction>>(null)
  const fits = useTabsFit(stripRef, measureRef, active === null ? 0 : pages.length)
  const compact = active !== null && !fits
  const move = (from: number, to: number) => {
    if (editor) moveNotePage(editor, from, to, t("docEditor.notePages.introduction"))
  }
  const drag = useNotePageDrag(move)
  const reducedMotion = useReducedMotion()
  const canExtract = Boolean(selection && !selection.empty && editor && notePageExtraction(editor))
  React.useEffect(() => {
    if (!editor || !compact) return
    const open = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.shiftKey ||
        !event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.code !== "KeyG"
      )
        return
      const wrapper = editor.view.dom.closest(".amby-tiptap")
      const target = event.target
      if (
        !wrapper ||
        wrapper.closest('[aria-hidden="true"]') ||
        !(target instanceof Node) ||
        !wrapper.contains(target)
      )
        return
      event.preventDefault()
      setPickingPage(true)
    }
    window.addEventListener("keydown", open)
    return () => window.removeEventListener("keydown", open)
  }, [editor, compact])
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
  const canMove = (index: number) => editable && Boolean(pages[index])
  const relativePath = toRelativeVaultPath(notePath ?? "", vaultPath)
  const linkTarget = (
    /^(?:\/|[a-z]:\/)/iu.test(relativePath) ? (relativePath.split("/").pop() ?? "") : relativePath
  ).replace(/\.md$/iu, "")
  const linkFor = (index: number) => {
    const heading = pages[index]?.title
    return linkTarget &&
      heading &&
      !/[[\]|#^\r\n]/u.test(linkTarget) &&
      !/[[\]|\r\n]/u.test(heading)
      ? `[[${linkTarget}#${heading}]]`
      : null
  }
  const copyLink = async (index: number) => {
    const link = linkFor(index)
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      logger.warn("editor.note_page_link_copy_failed")
    }
  }
  const remove = async (index: number) => {
    const page = pages[index]
    if (!editor || !page) return
    const answer = await confirmChoice(confirmations.deleteNotePage({ name: title(page, index) }))
    if (answer === "yes") deleteNotePage(editor, index, false)
    else if (answer === "alternative") deleteNotePage(editor, index, true)
  }
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
      {createPortal(
        <AnimatePresence>
          {drag.preview && pages[drag.preview.from] && (
            <motion.div
              aria-hidden="true"
              className={cn(
                "amby-note-page-drag-preview",
                drag.preview.axis === "x" ? PILL : "rounded-md px-2 text-sm",
              )}
              style={{
                left: drag.preview.box.left,
                top: drag.preview.box.top,
                width: drag.preview.box.width,
                height: drag.preview.box.height,
                [drag.preview.axis]: drag.offset,
              }}
              initial={reducedMotion ? false : { opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={
                reducedMotion
                  ? { opacity: 0, transition: motionTransitions.instant }
                  : { opacity: 0, transition: motionTransitions.fast }
              }
            >
              <span className="truncate">{title(pages[drag.preview.from], drag.preview.from)}</span>
            </motion.div>
          )}
        </AnimatePresence>,
        stripRef.current?.ownerDocument.body ?? document.body,
      )}
      {compact && pickingPage && (
        <NotePagePicker
          titles={pages.map(title)}
          onClose={() => setPickingPage(false)}
          onSelect={(index) => {
            setPickingPage(false)
            select(index)
          }}
        />
      )}
      {extracting && (
        <ExtractNotePageDialog
          onClose={() => setExtracting(null)}
          onCreate={(name) => {
            setExtracting(null)
            if (editor && extractNotePage(editor, extracting, name)) {
              requestAnimationFrame(() => {
                if (!editor.isDestroyed) editor.view.focus()
              })
            }
          }}
        />
      )}
      {slot && switcher ? createPortal(switcher, slot) : null}
      {((shown && (active !== null || !slot)) || (canAdd && pages.length < 2)) && (
        <div ref={stripRef} className="relative mb-4 flex min-w-0 items-center gap-2">
          {active !== null ? (
            <>
              {/* An invisible copy of the full row: its width decides whether the tabs fold. */}
              <div
                ref={measureRef}
                aria-hidden="true"
                data-note-page-measure=""
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
                    data-note-page-reorder=""
                    {...drag.groupProps}
                    className="h-auto max-w-full flex-nowrap justify-start gap-1 rounded-none bg-transparent p-0"
                  >
                    {drag.orderFor(pages.length, "x").map((index) => {
                      const page = pages[index]
                      const lifted = drag.preview?.axis === "x" && drag.preview.from === index
                      return renaming === index ? (
                        <PageNameField
                          key={index}
                          initial={page.title ?? ""}
                          label={nameLabel}
                          onDone={(name) => finishRename(index, name)}
                        />
                      ) : (
                        <motion.div
                          key={notePageIdentity(pages, index)}
                          layout={reducedMotion ? false : "position"}
                          transition={motionTransitions.reorder}
                          data-note-page-drag-item={canMove(index) ? index : undefined}
                          data-note-page-lifted={lifted || undefined}
                          className="flex-none"
                        >
                          <ContextMenu>
                            <ContextMenuTrigger asChild>
                              <TabsTrigger
                                id={`${panelId}-${index}`}
                                aria-controls={panelId}
                                value={String(index)}
                                className={cn(PILL, TAB, "select-none")}
                                onPointerDown={(event) => {
                                  if (canMove(index)) drag.begin(event, index, "x")
                                }}
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
                                disabled={!linkFor(index)}
                                onSelect={() => void copyLink(index)}
                              >
                                <Link2 className="size-4" />
                                {t("docEditor.notePages.copyLink")}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!canMove(index) || !canMove(index - 1)}
                                onSelect={() => move(index, index - 1)}
                              >
                                <ArrowLeft className="size-4" />
                                {t("docEditor.notePages.moveEarlier")}
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!canMove(index) || !canMove(index + 1)}
                                onSelect={() => move(index, index + 1)}
                              >
                                <ArrowRight className="size-4" />
                                {t("docEditor.notePages.moveLater")}
                              </ContextMenuItem>
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
                        </motion.div>
                      )
                    })}
                  </TabsList>
                </Tabs>
              ) : renaming === active ? (
                <PageNameField
                  initial={pages[active].title ?? ""}
                  label={nameLabel}
                  onDone={(name) => finishRename(active, name)}
                />
              ) : (
                <DropdownMenu
                  onOpenChange={(open) => {
                    if (!open) drag.cancel()
                  }}
                >
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
                    <div data-note-page-reorder="" {...drag.groupProps}>
                      {drag.orderFor(pages.length, "y").map((index) => {
                        const page = pages[index]
                        const lifted = drag.preview?.axis === "y" && drag.preview.from === index
                        return (
                          <motion.div
                            key={notePageIdentity(pages, index)}
                            layout={reducedMotion ? false : "position"}
                            transition={motionTransitions.reorder}
                            data-note-page-drag-item={canMove(index) ? index : undefined}
                            data-note-page-lifted={lifted || undefined}
                          >
                            <DropdownMenuItem
                              onPointerDown={(event) => {
                                if (canMove(index)) drag.begin(event, index, "y")
                              }}
                              onSelect={() => select(index)}
                              className={cn(index === active && "font-medium")}
                            >
                              {canMove(index) && (
                                <GripVertical aria-hidden="true" className="size-3.5" />
                              )}
                              <span className="flex-1 truncate">{title(page, index)}</span>
                              {index === active && <Check className="size-4 text-primary" />}
                            </DropdownMenuItem>
                          </motion.div>
                        )
                      })}
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setPickingPage(true)}>
                      <Search className="size-4" />
                      {t("docEditor.notePages.jump")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!linkFor(active)}
                      onSelect={() => void copyLink(active)}
                    >
                      <Link2 className="size-4" />
                      {t("docEditor.notePages.copyLink")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMove(active) || !canMove(active - 1)}
                      onSelect={() => move(active, active - 1)}
                    >
                      <ArrowLeft className="size-4" />
                      {t("docEditor.notePages.moveEarlier")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMove(active) || !canMove(active + 1)}
                      onSelect={() => move(active, active + 1)}
                    >
                      <ArrowRight className="size-4" />
                      {t("docEditor.notePages.moveLater")}
                    </DropdownMenuItem>
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
                  <DropdownMenuItem
                    disabled={!canExtract}
                    onSelect={() => editor && setExtracting(notePageExtraction(editor))}
                  >
                    <FileOutput className="size-4" />
                    {t("docEditor.notePages.extract")}
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
