import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  createTextPage,
  type CreatedTextPage,
  type ProjectCatalog,
  type WorkshopSummary,
} from "@/lib/storage"
import type { PanelRenderProps } from "../../panel-registry"
import { projectErrorText } from "../project-error"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { PanelSearch } from "../../panels/panel-header"
import { splitChooserOptions, type ChooserOption, type CreateChoice } from "../chooser-options"
import { useDatabaseStore } from "../../database/database-store"
import { useCreativeNavStore } from "../creative-nav-store"
import { writeWorkshopPrefs } from "../creative-scope-storage"
import { useTextStats } from "../use-text-stats"
import { SearchResults } from "./search-results"
import {
  buildTextTree,
  countNodes,
  findNode,
  lastOrderKey,
  startLevelId,
  textOrder,
  type TextNode,
} from "./text-tree-model"
import { useDatabaseRows } from "./use-database-rows"
import { useViewManualOrder } from "./use-view-order"
import { NotesPart } from "./notes-part"
import { buildNotebookTree, noteItemsOf } from "./notebook-model"
import { useNotebookActions } from "./use-notebook-actions"
import { useNotebooks } from "./use-notebooks"
import { WorksTab, type NotesSlot, type PlotPart } from "./works-tab"
import { WorldSection, type PlotRow } from "./world-section"
import { pagesOf, readBindings, type PageBinding } from "./plot-model"
import { usePlotBinding, type EnsurePlot } from "./use-plot-binding"
import { ItemActionsContext, type ItemActions } from "./item-actions"
import {
  WORKS_SECTIONS,
  buildMembership,
  buildSearchGroups,
  entityItemsOf,
  entityTabs,
  groupPropertyOf,
  resolvePanelFilter,
  scopeEntities,
  selectedStoryOf,
  storyLabels,
  storySection,
  workshopScope,
  type EntityItem,
  type GroupContext,
  type WorkshopDraft,
  type WorkshopTab,
  type WorksSection,
} from "./workshop-model"

interface WorkshopPaneProps {
  catalog: ProjectCatalog
  /** The resolved scope: a workshop's ID, or null. */
  scopeId: string | null
  vault: string | null
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  /** The page open in the editor, to mark in the lists. */
  activeNoteId: string | null
  onOpenProject: (projectId: string) => void
  /** `options` prefill the dialog: the anchors section a workshop does not have yet. */
  onAddSection: (workshop: WorkshopSummary, options?: { choice: "anchors"; name: string }) => void
  /**
   * Creates a page in a world category under the name the author typed, linked to `storyId` when
   * it is given; rejects on failure. The category `"notes"` is the notes base, whose pages may
   * also name the `notebook` (folder names from the base's root) they are made in.
   */
  onCreateEntity: (
    categoryKey: string,
    title: string,
    storyId: string | null,
    notebook?: string[],
  ) => Promise<void>
  /**
   * Links a section of an older workshop (a world section to stories, or the stories section to
   * universes) and reads the catalog again; rejects on failure.
   */
  onLinkSection: (workshop: WorkshopSummary, sectionId: string) => Promise<void>
  /**
   * Makes the missing link properties of anchors and arcs (the first binding needs them) and reads
   * the catalog again; rejects on failure.
   */
  onEnsurePlot: EnsurePlot
  /** What a page's own menu can do besides opening it. */
  itemActions: Pick<ItemActions, "onOpenInNewTab" | "onRename" | "onDelete" | "onDeleteMany">
  /**
   * The tree's own move and the refresh after a write: notebooks are folders, so a note moves,
   * a notebook is renamed and an emptied one is trashed by the operations the file tree uses.
   */
  fileActions: Pick<PanelRenderProps, "onMoveItem" | "onCreativeChanged">
  /** The menu of the empty space: what can be created from here, the "Create" button's list. */
  createOptions: ChooserOption[]
  onCreate: (choice: CreateChoice) => void
}

/**
 * The body of the workshop panel, as one column: search, chosen story with text tree,
 * anchors, notes, and world sections.
 */
export function WorkshopPane({
  catalog,
  scopeId,
  vault,
  vaultGeneration,
  onOpenNote,
  activeNoteId,
  onOpenProject,
  onAddSection,
  onCreateEntity,
  onLinkSection,
  onEnsurePlot,
  itemActions,
  fileActions,
  createOptions,
  onCreate,
}: WorkshopPaneProps) {
  const { t } = useTranslation()
  const databases = useDatabaseStore((state) => state.databases)
  const rawFilter = useCreativeNavStore((state) => state.storyFilter)
  const setStoryFilter = useCreativeNavStore((state) => state.setStoryFilter)
  const universeFilter = useCreativeNavStore((state) => state.universeFilter)
  const setUniverseFilter = useCreativeNavStore((state) => state.setUniverseFilter)
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const worksOpen = useCreativeNavStore((state) => state.worksOpen)
  const toggleWorksSection = useCreativeNavStore((state) => state.toggleWorksSection)
  const collapsed = useCreativeNavStore((state) => state.collapsed)
  const toggleCollapsed = useCreativeNavStore((state) => state.toggleCollapsed)
  const search = useCreativeNavStore((state) => state.search)
  const setSearch = useCreativeNavStore((state) => state.setSearch)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const pageRequest = useCreativeNavStore((state) => state.pageRequest)
  const entityRequest = useCreativeNavStore((state) => state.entityRequest)

  const scope = React.useMemo(() => workshopScope(catalog, scopeId), [catalog, scopeId])
  const categories = React.useMemo(() => entityTabs(scope), [scope])
  const searching = search.trim() !== ""
  // The story the stored choice names, before it is known whether a universe overrides it.
  const chosenStory = rawFilter === "all" ? null : selectedStoryOf(scope.stories, rawFilter)
  // Every story's text is read when the whole workshop or a universe is shown: a page is in a
  // story when that story's text names it. A single story reads only its own.
  const readsEveryText = universeFilter !== null || rawFilter === "all" || searching

  const databaseIds = React.useMemo(() => {
    const ids: string[] = []
    if (chosenStory?.databaseId) ids.push(chosenStory.databaseId)
    if (readsEveryText) {
      for (const story of scope.stories) {
        if (story.databaseId) ids.push(story.databaseId)
      }
    }
    if (scope.workshop) {
      const notesSec = storySection(scope.workshop, "notes")
      if (notesSec) ids.push(notesSec.databaseId)
      const anchorsSec = storySection(scope.workshop, "anchors")
      if (anchorsSec) ids.push(anchorsSec.databaseId)
      const univSec = scope.workshop.sections.find((s) => s.role === "universes")
      if (univSec) {
        ids.push(univSec.databaseId)
        // The stories' own cards say which universe each belongs to.
        const storiesSec = scope.workshop.sections.find((s) => s.role === "stories")
        if (storiesSec && storiesSec.state !== "missing") ids.push(storiesSec.databaseId)
      }
    }
    for (const category of categories) {
      ids.push(category.databaseId)
    }
    return ids
  }, [categories, chosenStory, readsEveryText, scope.stories, scope.workshop])

  const data = useDatabaseRows(databaseIds, dataNonce)

  const anchorsDatabaseId = scope.workshop
    ? storySection(scope.workshop, "anchors")?.databaseId
    : null
  const anchorStats = useTextStats(anchorsDatabaseId, dataNonce)
  const anchorCreated = React.useMemo(
    () => Object.fromEntries(Object.entries(anchorStats).map(([id, stat]) => [id, stat.created])),
    [anchorStats],
  )
  const anchorView = useViewManualOrder(
    databases.find((database) => database.databaseId === anchorsDatabaseId),
    dataNonce,
  )

  const itemsByCategory = React.useMemo(() => {
    const result: Record<string, EntityItem[]> = {}
    for (const category of categories) {
      result[category.key] = (data.rows[category.databaseId] ?? []).map((row) => ({
        noteId: row.noteId,
        title: row.title,
        databaseId: category.databaseId,
        workshopId: scope.workshop?.workshopId ?? "",
        valuesJson: row.valuesJson,
      }))
    }
    return result
  }, [categories, data.rows, scope.workshop?.workshopId])

  const universesSection = scope.workshop?.sections.find((s) => s.role === "universes")
  const universes = React.useMemo(() => {
    if (!universesSection) return []
    return (data.rows[universesSection.databaseId] ?? []).map((row) => ({
      noteId: row.noteId,
      title: row.title,
    }))
  }, [data.rows, universesSection])

  const filter = React.useMemo(
    () =>
      resolvePanelFilter(
        scope.stories,
        universes.map((universe) => universe.noteId),
        rawFilter,
        universeFilter,
      ),
    [rawFilter, scope.stories, universeFilter, universes],
  )
  const selectedStory =
    filter.kind === "story"
      ? (scope.stories.find((story) => story.storyId === filter.storyId) ?? null)
      : null

  const membership = React.useMemo(
    () =>
      buildMembership({
        stories: scope.stories,
        sections: scope.workshop?.sections ?? [],
        rows: data.rows,
      }),
    [data.rows, scope.stories, scope.workshop?.sections],
  )
  const scoped = React.useMemo(() => {
    const shown: Record<string, EntityItem[]> = {}
    const withoutStory: Record<string, EntityItem[]> = {}
    for (const category of categories) {
      const result = scopeEntities(itemsByCategory[category.key] ?? [], filter, membership)
      shown[category.key] = result.shown
      withoutStory[category.key] = result.withoutStory
    }
    return { shown, withoutStory }
  }, [categories, filter, itemsByCategory, membership])
  // Notes: the base's rows grouped by notebook under the same filter as the world.
  const notesSection = scope.workshop ? storySection(scope.workshop, "notes") : null
  const allNotes = React.useMemo(
    () =>
      notesSection
        ? noteItemsOf(
            data.rows[notesSection.databaseId] ?? [],
            notesSection.databaseId,
            scope.workshop?.workshopId ?? "",
          )
        : [],
    [data.rows, notesSection, scope.workshop?.workshopId],
  )
  const { catalog: notebookCatalog, reload: reloadNotebooks } = useNotebooks(
    notesSection?.databaseId,
    dataNonce,
  )
  const scopedNotes = React.useMemo(
    () => scopeEntities(allNotes, filter, membership),
    [allNotes, filter, membership],
  )
  const notesTree = React.useMemo(
    () =>
      buildNotebookTree(notebookCatalog?.notebooks ?? [], scopedNotes.shown, { showEmpty: true }),
    [notebookCatalog, scopedNotes.shown],
  )
  const notesWithoutStory = React.useMemo(
    () =>
      filter.kind === "all"
        ? buildNotebookTree(notebookCatalog?.notebooks ?? [], scopedNotes.withoutStory, {
            showEmpty: false,
          })
        : null,
    [filter.kind, notebookCatalog, scopedNotes.withoutStory],
  )
  const storyNames = React.useMemo(
    () => new Map(scope.stories.map((story) => [story.storyId, story.name])),
    [scope.stories],
  )
  const labelsOf = React.useMemo(
    () =>
      filter.kind === "story"
        ? null
        : (noteId: string) =>
            storyLabels(membership.storiesOf(noteId), (storyId) => storyNames.get(storyId)),
    [filter.kind, membership, storyNames],
  )

  const stats = useTextStats(selectedStory?.databaseId, dataNonce)

  const groupContext = React.useMemo<GroupContext>(
    () => ({
      groupProperty: (databaseId) =>
        groupPropertyOf(databases.find((database) => database.databaseId === databaseId)),
      sharedLabel: t("creative.workshop.shared", "Общие"),
      noValueLabel: t("creative.workshop.noImportance", "Без значимости"),
    }),
    [databases, t],
  )

  const searchGroups = React.useMemo(() => {
    if (!searching) return []
    const asItem = (
      row: { noteId: string; title: string; valuesJson: string },
      databaseId: string,
    ): EntityItem => ({
      noteId: row.noteId,
      title: row.title,
      databaseId,
      workshopId: scope.workshop?.workshopId ?? "",
      valuesJson: row.valuesJson,
    })
    const works: EntityItem[] = []
    for (const story of scope.stories) {
      if (story.databaseId) {
        for (const row of data.rows[story.databaseId] ?? []) {
          works.push(asItem(row, story.databaseId))
        }
      }
    }
    if (scope.workshop) {
      const notesSec = storySection(scope.workshop, "notes")
      if (notesSec) {
        for (const row of data.rows[notesSec.databaseId] ?? []) {
          works.push(asItem(row, notesSec.databaseId))
        }
      }
      const anchorsSec = storySection(scope.workshop, "anchors")
      if (anchorsSec) {
        for (const row of data.rows[anchorsSec.databaseId] ?? []) {
          works.push(asItem(row, anchorsSec.databaseId))
        }
      }
    }
    return buildSearchGroups(search, [
      { key: "works", label: t("creative.workshop.works", "Произведения"), items: works },
      ...categories.map((category) => ({
        key: category.key,
        label: category.name,
        items: itemsByCategory[category.key] ?? [],
      })),
    ])
  }, [categories, data.rows, itemsByCategory, scope.stories, scope.workshop, search, searching, t])

  const [draft, setDraft] = React.useState<WorkshopDraft | null>(null)
  const notebookActions = useNotebookActions({
    catalog: notebookCatalog,
    reload: reloadNotebooks,
    notes: allNotes,
    notesComplete: !data.truncated && data.status === "ready",
    vault,
    onMoveItem: fileActions.onMoveItem,
    onRename: itemActions.onRename,
    onCreativeChanged: fileActions.onCreativeChanged,
    onChanged: bumpData,
  })

  // Linking a section made before the links existed: one operation, shown on the section's row.
  const [linking, setLinking] = React.useState<string | null>(null)
  const [linkError, setLinkError] = React.useState<string | null>(null)
  const linkSection = async (sectionId: string) => {
    if (!scope.workshop || linking !== null) return
    setLinking(sectionId)
    setLinkError(null)
    try {
      await onLinkSection(scope.workshop, sectionId)
      bumpData()
    } catch (caught) {
      setLinkError(t("creative.workshop.link.failed", { message: projectErrorText(t, caught) }))
    } finally {
      setLinking(null)
    }
  }
  const storiesSection = scope.workshop?.sections.find((section) => section.role === "stories")
  const canLinkUniverses = Boolean(
    storiesSection &&
    storiesSection.state !== "missing" &&
    !storiesSection.universePropertyId &&
    universesSection &&
    universesSection.state !== "missing" &&
    !scope.workshop?.readOnly,
  )

  const rootsOf = React.useCallback(
    (storyId: string): TextNode[] => {
      const story = scope.stories.find((candidate) => candidate.storyId === storyId)
      const rows = story?.databaseId ? data.rows[story.databaseId] : undefined
      return story?.text && rows ? buildTextTree(rows, story.text.properties) : []
    },
    [data.rows, scope.stories],
  )

  const totals = React.useMemo(() => {
    const textDatabaseId = selectedStory?.databaseId
    const loaded = textDatabaseId ? data.rows[textDatabaseId] !== undefined : false
    const known = Object.values(stats)
    return {
      pages: selectedStory && loaded ? countNodes(rootsOf(selectedStory.storyId)) : null,
      words: known.length > 0 ? known.reduce((sum, stat) => sum + stat.wordCount, 0) : null,
    }
  }, [data.rows, rootsOf, selectedStory, stats])

  // Anchors and arcs of the shown story: which ones belong to it, how its pages are bound.
  const plotBinding = usePlotBinding({
    workshop: scope.workshop,
    story: selectedStory,
    rows: data.rows,
    vaultGeneration,
    ensure: onEnsurePlot,
    onChanged: bumpData,
  })
  const anchorsSection = scope.workshop ? storySection(scope.workshop, "anchors") : null
  const arcsCategory = categories.find((category) => category.role === "arcs")
  // The rows of a database that belong to the shown story (none unless one story is shown).
  const belonging = React.useCallback(
    (databaseId: string | undefined) => {
      if (!databaseId || !scope.workshop || filter.kind !== "story") return []
      const rows = data.rows[databaseId] ?? []
      const shown = new Set(
        scopeEntities(
          entityItemsOf(rows, databaseId, scope.workshop.workshopId),
          filter,
          membership,
        ).shown.map((item) => item.noteId),
      )
      return rows.filter((row) => shown.has(row.noteId))
    },
    [data.rows, filter, membership, scope.workshop],
  )
  const storyAnchors = React.useMemo(
    () => belonging(anchorsSection?.databaseId),
    [anchorsSection?.databaseId, belonging],
  )
  const storyArcs = React.useMemo(
    () => belonging(arcsCategory?.databaseId),
    [arcsCategory?.databaseId, belonging],
  )
  const bindings = React.useMemo(() => {
    const text = selectedStory?.text
    return text?.databaseId
      ? readBindings(data.rows[text.databaseId] ?? [], text.properties)
      : new Map<string, PageBinding>()
  }, [data.rows, selectedStory])
  const plot: PlotPart = {
    anchors: storyAnchors,
    arcs: storyArcs,
    bindings,
    binding:
      scope.workshop && !scope.workshop.readOnly && selectedStory?.text?.databaseId
        ? plotBinding
        : null,
    linkAnchors:
      anchorsSection && !anchorsSection.storiesPropertyId && !scope.workshop?.readOnly
        ? {
            pending: linking === anchorsSection.id,
            error: linkError,
            onLink: () => void linkSection(anchorsSection.id),
          }
        : null,
  }
  // The text's order and titles, found once per read of the data, for the arcs' menus.
  const plotPages = React.useMemo(() => {
    const text = selectedStory?.text
    if (!selectedStory || !text?.databaseId) return null
    return {
      order: textOrder(rootsOf(selectedStory.storyId)),
      titles: new Map((data.rows[text.databaseId] ?? []).map((row) => [row.noteId, row.title])),
    }
  }, [data.rows, rootsOf, selectedStory])
  const plotRowOf = (tab: WorkshopTab, item: EntityItem): PlotRow | null => {
    const binding = plot.binding
    if (tab.role !== "arcs" || !binding || !plotPages) return null
    const pages = pagesOf(plot.bindings, plotPages.order, "arc", item.noteId)
    return {
      drag: { kind: "arc", id: item.noteId },
      menu:
        pages.length > 0
          ? {
              unbind: {
                pages: pages.map((id) => ({ id, title: plotPages.titles.get(id) ?? "" })),
                onUnbind: (pageId) => void binding.unbind(pageId, "arc", item.noteId),
              },
            }
          : undefined,
      error: binding.error?.rowId === item.noteId ? binding.error.message : null,
    }
  }

  const remember = (patch: Parameters<typeof writeWorkshopPrefs>[1]) => {
    if (vault) writeWorkshopPrefs(vault, patch)
  }

  const showPart = (section: WorksSection) => {
    if (useCreativeNavStore.getState().worksOpen[section]) return
    toggleWorksSection(section)
    const next = useCreativeNavStore.getState().worksOpen
    remember({ works: WORKS_SECTIONS.filter((entry) => next[entry]) })
  }
  const unfold = (key: string) => {
    if (useCreativeNavStore.getState().collapsed[key]) toggleCollapsed(key)
  }

  const startPage = (storyId: string, parentId: string | null) => {
    setSearch("")
    setUniverseFilter(null)
    setStoryFilter(storyId)
    showPart("text")
    if (parentId) unfold(`page:${parentId}`)
    setDraft({ kind: "page", storyId, parentId })
  }
  const startAnchor = () => {
    setSearch("")
    showPart("anchors")
    setDraft({ kind: "anchor" })
  }
  const startNote = (notebook: string[]) => {
    setSearch("")
    showPart("notes")
    if (notebook.length > 0) unfold(`notebook:${notebook.join("/")}`)
    notebookActions.clearError()
    setDraft({ kind: "note", notebook })
  }
  const startNotebook = (parent: string[]) => {
    setSearch("")
    showPart("notes")
    if (parent.length > 0) unfold(`notebook:${parent.join("/")}`)
    notebookActions.clearError()
    setDraft({ kind: "notebook", parent })
  }
  const startEntity = (categoryKey: string) => {
    setSearch("")
    unfold(`category:${categoryKey}`)
    setDraft({ kind: "entity", categoryKey })
  }

  const handledPage = React.useRef(pageRequest?.id ?? 0)
  React.useEffect(() => {
    if (!pageRequest || pageRequest.id === handledPage.current) return
    handledPage.current = pageRequest.id
    const storyId =
      pageRequest.storyId ?? selectedStory?.storyId ?? scope.stories[0]?.storyId ?? null
    if (storyId) startPage(storyId, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRequest])
  const handledEntity = React.useRef(entityRequest?.id ?? 0)
  React.useEffect(() => {
    if (!entityRequest || entityRequest.id === handledEntity.current) return
    handledEntity.current = entityRequest.id
    startEntity(entityRequest.categoryKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityRequest])

  const commitDraft = async (title: string) => {
    if (!draft || vaultGeneration === null) return
    if (draft.kind === "entity") {
      // Made while a story is shown, a page is linked to it from the first write.
      const tab = categories.find((category) => category.key === draft.categoryKey)
      const storyId = filter.kind === "story" && tab?.storiesPropertyId ? filter.storyId : null
      await onCreateEntity(draft.categoryKey, title, storyId)
      setDraft(null)
      return
    }
    if (draft.kind === "page") {
      const story = scope.stories.find((candidate) => candidate.storyId === draft.storyId)
      if (!story) throw new Error(t("creative.errors.projectNotFound"))
      const text = story.text
      if (!text?.databaseId) throw new Error(t("creative.workshop.noText"))
      const roots = rootsOf(story.storyId)
      const parent = draft.parentId ? findNode(roots, draft.parentId) : null
      const levelId = startLevelId(text.levels, parent)
      if (!levelId) throw new Error(t("creative.workshop.noLevels"))
      const formats = text.formats.filter((format) => format.state === "ok")
      const format = formats.find((entry) => entry.kind === "manuscript") ?? formats[0]
      const created = await createTextPage({
        expectedGeneration: vaultGeneration,
        storyId: story.storyId,
        title,
        parentNoteId: parent?.noteId ?? null,
        levelId,
        formatId: format?.id ?? null,
        orderKey: lastOrderKey(parent ? parent.children : roots),
      })
      setDraft(null)
      afterPage(created)
      return
    }
    if (draft.kind === "notebook") {
      await notebookActions.createNotebook(draft.parent, title)
      setDraft(null)
      return
    }
    if (draft.kind === "note") {
      // Made while a story is shown, a note is linked to it from the first write, and it lies in
      // the notebook the row stood in.
      const storyId =
        filter.kind === "story" && notesSection?.storiesPropertyId ? filter.storyId : null
      await onCreateEntity("notes", title, storyId, draft.notebook ?? [])
      setDraft(null)
      return
    }
    // An anchor made while a story is shown belongs to it from the first write.
    const sec = storySection(scope.workshop, "anchors")
    if (!sec) throw new Error(t("creative.errors.projectNotFound"))
    const storyId = filter.kind === "story" && sec.storiesPropertyId ? filter.storyId : null
    await onCreateEntity("anchors", title, storyId)
    setDraft(null)
  }

  const afterPage = (created: CreatedTextPage) => {
    bumpData()
    onOpenNote(created.noteId)
  }

  const iconOf = (databaseId: string) =>
    databases.find((database) => database.databaseId === databaseId)?.icon ?? null

  const { common, rare } = splitChooserOptions(createOptions)

  const actions = React.useMemo<ItemActions>(
    () => ({ onOpen: onOpenNote, ...itemActions }),
    [itemActions, onOpenNote],
  )

  const notesSlot: NotesSlot | null = notesSection
    ? {
        count: notesTree.count + (notesWithoutStory?.count ?? 0),
        onAdd: scope.workshop?.readOnly ? null : () => startNote([]),
        content: (
          <NotesPart
            tree={notesTree}
            withoutStory={notesWithoutStory}
            canWrite={!scope.workshop?.readOnly}
            loading={data.status === "loading" || data.status === "idle"}
            activeNoteId={activeNoteId}
            onOpenNote={onOpenNote}
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            storyLabelsOf={labelsOf}
            draft={draft}
            onCommitDraft={commitDraft}
            onCancelDraft={() => setDraft(null)}
            onAddNote={startNote}
            onAddNotebook={startNotebook}
            actions={notebookActions}
            link={
              notesSection && !notesSection.storiesPropertyId && !scope.workshop?.readOnly
                ? {
                    pending: linking === notesSection.id,
                    error: linkError,
                    onLink: () => void linkSection(notesSection.id),
                  }
                : null
            }
          />
        ),
      }
    : null

  if (!scope.workshop) return null

  return (
    <ItemActionsContext.Provider value={actions}>
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelSearch
          value={search}
          onChange={setSearch}
          placeholder={t("creative.workshop.search")}
          ariaLabel={t("creative.workshop.search")}
        />
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex min-h-0 flex-1 flex-col">
              {searching ? (
                <SearchResults
                  groups={searchGroups}
                  projectName={() => scope.workshop?.name ?? ""}
                  status={data.status}
                  error={data.error}
                  onOpen={onOpenNote}
                />
              ) : (
                <WorksTab
                  workshop={scope.workshop}
                  stories={scope.stories}
                  selectedStoryId={selectedStory?.storyId ?? null}
                  universes={universes}
                  selectedUniverseId={filter.kind === "universe" ? filter.universeId : null}
                  onSelectStory={(storyId) => {
                    // `null` is the whole workshop; it is stored as "all" because an empty choice
                    // means "the first story".
                    setDraft(null)
                    setUniverseFilter(null)
                    const next = storyId ?? "all"
                    setStoryFilter(next)
                    remember({ story: next })
                  }}
                  onSelectUniverse={(universeId) => {
                    setDraft(null)
                    setUniverseFilter(universeId)
                  }}
                  open={worksOpen}
                  onToggleSection={(section) => {
                    toggleWorksSection(section)
                    const next = useCreativeNavStore.getState().worksOpen
                    remember({ works: WORKS_SECTIONS.filter((entry) => next[entry]) })
                  }}
                  rows={data.rows}
                  status={data.status}
                  error={data.error}
                  vaultGeneration={vaultGeneration}
                  onOpenNote={onOpenNote}
                  onOpenProject={onOpenProject}
                  onNewStory={() => onCreate("story")}
                  totals={totals}
                  onAddPage={(story, parent) => startPage(story.storyId, parent?.noteId ?? null)}
                  onAddAnchor={startAnchor}
                  notes={notesSlot}
                  onCreateAnchors={() => {
                    if (scope.workshop) {
                      onAddSection(scope.workshop, {
                        choice: "anchors",
                        name: t("creative.workshop.anchorsName", "Якоря"),
                      })
                    }
                  }}
                  onMoved={bumpData}
                  activeNoteId={activeNoteId}
                  stats={stats}
                  plot={plot}
                  anchorOrder={anchorView.order}
                  anchorCreated={anchorCreated}
                  onReorderAnchors={anchorView.save}
                  draft={draft}
                  onCommitDraft={commitDraft}
                  onCancelDraft={() => setDraft(null)}
                >
                  <WorldSection
                    categories={categories}
                    itemsByCategory={scoped.shown}
                    withoutStoryByCategory={scoped.withoutStory}
                    storyLabelsOf={labelsOf}
                    plotRowOf={plotRowOf}
                    onLinkSection={(tab: WorkshopTab) => void linkSection(tab.sectionId)}
                    linkingSectionId={linking}
                    onLinkUniverses={
                      canLinkUniverses && storiesSection
                        ? () => void linkSection(storiesSection.id)
                        : null
                    }
                    linkError={linkError}
                    groupContext={groupContext}
                    collapsed={collapsed}
                    onToggle={toggleCollapsed}
                    iconOf={iconOf}
                    vaultGeneration={vaultGeneration}
                    status={data.status}
                    truncated={data.truncated}
                    onOpen={onOpenNote}
                    activeNoteId={activeNoteId}
                    onAddEntity={startEntity}
                    draftCategoryKey={draft?.kind === "entity" ? draft.categoryKey : null}
                    onCommitDraft={commitDraft}
                    onCancelDraft={() => setDraft(null)}
                  />
                </WorksTab>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent
            className="w-64 border-border bg-popover text-foreground"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <ContextMenuLabel className="text-[11px] text-muted-foreground">
              {t("creative.workshop.menu.create")}
            </ContextMenuLabel>
            {common.map(({ value, icon: Icon, title }) => (
              <ContextMenuItem
                key={value}
                className="gap-2 text-[13px]"
                onSelect={() => onCreate(value)}
              >
                <Icon className="size-3.5 text-muted-foreground" />
                <span className="truncate">{title}</span>
              </ContextMenuItem>
            ))}
            {common.length > 0 && rare.length > 0 && <ContextMenuSeparator />}
            {rare.map(({ value, icon: Icon, title }) => (
              <ContextMenuItem
                key={value}
                className="gap-2 text-[13px] text-muted-foreground"
                onSelect={() => onCreate(value)}
              >
                <Icon className="size-3.5" />
                <span className="truncate">{title}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </ItemActionsContext.Provider>
  )
}
