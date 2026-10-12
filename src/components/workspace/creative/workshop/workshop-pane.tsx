import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  createDatabaseRow,
  createTextPage,
  type CreatedTextPage,
  type ProjectCatalog,
  type ProjectSummary,
} from "@/lib/storage"
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
  type TextNode,
} from "./text-tree-model"
import { useDatabaseRows } from "./use-database-rows"
import { useViewManualOrder } from "./use-view-order"
import { WorksTab } from "./works-tab"
import { WorldSection } from "./world-section"
import { ItemActionsContext, type ItemActions } from "./item-actions"
import {
  WORKS_SECTIONS,
  buildSearchGroups,
  entityTabs,
  groupPropertyOf,
  relationTargets,
  selectedStoryOf,
  storySection,
  workshopScope,
  type EntityItem,
  type GroupContext,
  type TextReferences,
  type WorkshopDraft,
  type WorksSection,
} from "./workshop-model"

interface WorkshopPaneProps {
  catalog: ProjectCatalog
  /** The resolved scope: a collection's project ID, or `null` for stand-alone stories. */
  scopeId: string | null
  vault: string | null
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  /** The page open in the editor, to mark in the lists. */
  activeNoteId: string | null
  onOpenProject: (projectId: string) => void
  /** `options` prefill the dialog: the anchors section a story does not have yet. */
  onAddSection: (project: ProjectSummary, options?: { choice: "anchors"; name: string }) => void
  /** Creates a page in a world category under the name the author typed; rejects on failure. */
  onCreateEntity: (categoryKey: string, title: string) => Promise<void>
  /** What a page's own menu can do besides opening it. */
  itemActions: Pick<ItemActions, "onOpenInNewTab" | "onRename" | "onDelete" | "onDeleteMany">
  /** The menu of the empty space: what can be created from here, the "Create" button's list. */
  createOptions: ChooserOption[]
  onCreate: (choice: CreateChoice) => void
}

/**
 * The body of the workshop panel, as one column: the search, the chosen story with its parts
 * (the text, anchors, notes) and under them the world (characters, locations and the author's
 * own categories), which a switch narrows to the story or widens to the whole universe.
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
  itemActions,
  createOptions,
  onCreate,
}: WorkshopPaneProps) {
  const { t } = useTranslation()
  const databases = useDatabaseStore((state) => state.databases)
  const rawFilter = useCreativeNavStore((state) => state.storyFilter)
  const setStoryFilter = useCreativeNavStore((state) => state.setStoryFilter)
  const worldScope = useCreativeNavStore((state) => state.worldScope)
  const setWorldScope = useCreativeNavStore((state) => state.setWorldScope)
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
  // The story chosen in the list; a choice from another universe falls back to the first.
  const selectedStory = selectedStoryOf(scope.stories, rawFilter)
  const searching = search.trim() !== ""

  const databaseIds = React.useMemo(() => {
    const ids: string[] = []
    const addStory = (story: ProjectSummary) => {
      if (story.text?.databaseId) ids.push(story.text.databaseId)
      for (const role of ["notes", "anchors"] as const) {
        const section = storySection(story, role)
        if (section) ids.push(section.databaseId)
      }
    }
    // The chosen story's parts; the search and the world's story marks read every story's text.
    if (selectedStory) addStory(selectedStory)
    if (searching) scope.stories.forEach(addStory)
    for (const story of scope.stories) if (story.text?.databaseId) ids.push(story.text.databaseId)
    for (const category of categories) {
      for (const source of category.sources) ids.push(source.section.databaseId)
    }
    return ids
  }, [categories, scope.stories, searching, selectedStory])
  const data = useDatabaseRows(databaseIds, dataNonce)
  const stats = useTextStats(selectedStory?.text?.databaseId, dataNonce)
  // Anchors keep the author's order: placed by hand in the view, else the order they were made.
  const anchorsDatabaseId = selectedStory
    ? storySection(selectedStory, "anchors")?.databaseId
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
      result[category.key] = category.sources.flatMap((source) =>
        (data.rows[source.section.databaseId] ?? []).map((row) => ({
          noteId: row.noteId,
          title: row.title,
          databaseId: source.section.databaseId,
          projectId: source.project.projectId,
          valuesJson: row.valuesJson,
        })),
      )
    }
    return result
  }, [categories, data.rows])

  const references = React.useMemo<TextReferences>(() => {
    const result = new Map<string, Set<string>>()
    for (const story of scope.stories) {
      const rows = story.text?.databaseId ? data.rows[story.text.databaseId] : undefined
      if (!rows) continue
      const targets = new Set<string>()
      for (const row of rows) for (const id of relationTargets(row.valuesJson)) targets.add(id)
      result.set(story.projectId, targets)
    }
    return result
  }, [data.rows, scope.stories])

  const groupContext = React.useMemo<GroupContext>(
    () => ({
      groupProperty: (databaseId) =>
        groupPropertyOf(databases.find((database) => database.databaseId === databaseId)),
      projectName: (projectId) =>
        catalog.projects.find((project) => project.projectId === projectId)?.name ?? "",
      sharedLabel: t("creative.workshop.shared"),
      noValueLabel: t("creative.workshop.noImportance"),
      projectOrder: [
        ...(scope.collection ? [scope.collection.projectId] : []),
        ...scope.stories.map((story) => story.projectId),
      ],
    }),
    [catalog.projects, databases, scope.collection, scope.stories, t],
  )

  const searchGroups = React.useMemo(() => {
    if (!searching) return []
    const asItem = (
      row: { noteId: string; title: string; valuesJson: string },
      databaseId: string,
      projectId: string,
    ): EntityItem => ({
      noteId: row.noteId,
      title: row.title,
      databaseId,
      projectId,
      valuesJson: row.valuesJson,
    })
    const works: EntityItem[] = []
    for (const story of scope.stories) {
      const sections = [
        story.text?.databaseId ?? null,
        storySection(story, "notes")?.databaseId ?? null,
        storySection(story, "anchors")?.databaseId ?? null,
      ]
      for (const databaseId of sections) {
        if (!databaseId) continue
        for (const row of data.rows[databaseId] ?? []) {
          works.push(asItem(row, databaseId, story.projectId))
        }
      }
    }
    return buildSearchGroups(search, [
      { key: "works", label: t("creative.workshop.works"), items: works },
      ...categories.map((category) => ({
        key: category.key,
        label: category.name,
        items: itemsByCategory[category.key] ?? [],
      })),
    ])
  }, [categories, data.rows, itemsByCategory, scope.stories, search, searching, t])

  // What is being named in the lists: a row with an empty field where the item will stand.
  const [draft, setDraft] = React.useState<WorkshopDraft | null>(null)

  const rootsOf = React.useCallback(
    (storyId: string): TextNode[] => {
      const story = scope.stories.find((candidate) => candidate.projectId === storyId)
      const rows = story?.text?.databaseId ? data.rows[story.text.databaseId] : undefined
      return story?.text && rows ? buildTextTree(rows, story.text.properties) : []
    },
    [data.rows, scope.stories],
  )

  // What the header says under the story's name; nothing until it is read, not "0".
  const totals = React.useMemo(() => {
    const textDatabaseId = selectedStory?.text?.databaseId
    const loaded = textDatabaseId ? data.rows[textDatabaseId] !== undefined : false
    const known = Object.values(stats)
    return {
      pages: selectedStory && loaded ? countNodes(rootsOf(selectedStory.projectId)) : null,
      words: known.length > 0 ? known.reduce((sum, stat) => sum + stat.wordCount, 0) : null,
    }
  }, [data.rows, rootsOf, selectedStory, stats])

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
    setStoryFilter(storyId)
    showPart("text")
    if (parentId) unfold(`page:${parentId}`)
    setDraft({ kind: "page", storyId, parentId })
  }
  const startListItem = (kind: "note" | "anchor", story: ProjectSummary) => {
    setSearch("")
    showPart(kind === "note" ? "notes" : "anchors")
    setDraft({ kind, storyId: story.projectId })
  }
  const startEntity = (categoryKey: string) => {
    setSearch("")
    unfold(`category:${categoryKey}`)
    setDraft({ kind: "entity", categoryKey })
  }

  // A page or a world page asked for from outside (the "Create" button) starts its row here,
  // where the lists are.
  const handledPage = React.useRef(pageRequest?.id ?? 0)
  React.useEffect(() => {
    if (!pageRequest || pageRequest.id === handledPage.current) return
    handledPage.current = pageRequest.id
    const storyId = pageRequest.storyId ?? selectedStory?.projectId ?? null
    if (storyId) startPage(storyId, null)
    // The request is the trigger; the helpers read the stores at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRequest])
  const handledEntity = React.useRef(entityRequest?.id ?? 0)
  React.useEffect(() => {
    if (!entityRequest || entityRequest.id === handledEntity.current) return
    handledEntity.current = entityRequest.id
    startEntity(entityRequest.categoryKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityRequest])

  /** Creates what the draft row names. A rejection stays on the row; success closes it. */
  const commitDraft = async (title: string) => {
    if (!draft || vaultGeneration === null) return
    if (draft.kind === "entity") {
      await onCreateEntity(draft.categoryKey, title)
      setDraft(null)
      return
    }
    const story = scope.stories.find((candidate) => candidate.projectId === draft.storyId)
    if (!story) throw new Error(t("creative.errors.projectNotFound"))
    if (draft.kind === "page") {
      const text = story.text
      if (!text?.databaseId) throw new Error(t("creative.workshop.noText"))
      const roots = rootsOf(story.projectId)
      const parent = draft.parentId ? findNode(roots, draft.parentId) : null
      const levelId = startLevelId(text.levels, parent)
      if (!levelId) throw new Error(t("creative.workshop.noLevels"))
      // The format is not asked for in daily use: the manuscript one unless the story lacks it.
      const formats = text.formats.filter((format) => format.state === "ok")
      const format = formats.find((entry) => entry.kind === "manuscript") ?? formats[0]
      const created = await createTextPage({
        expectedGeneration: vaultGeneration,
        projectId: story.projectId,
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
    const databaseId = storySection(story, draft.kind === "note" ? "notes" : "anchors")?.databaseId
    if (!databaseId) throw new Error(t("creative.errors.projectNotFound"))
    const created = await createDatabaseRow({
      expectedGeneration: vaultGeneration,
      databaseId,
      title,
      template: { kind: "default" },
    })
    setDraft(null)
    bumpData()
    onOpenNote(created.noteId)
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
                  projectName={groupContext.projectName}
                  status={data.status}
                  error={data.error}
                  onOpen={onOpenNote}
                />
              ) : (
                <WorksTab
                  stories={scope.stories}
                  selectedStoryId={selectedStory?.projectId ?? null}
                  onSelectStory={(storyId) => {
                    setDraft(null)
                    setStoryFilter(storyId)
                    remember({ story: storyId })
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
                  onAddPage={(story, parent) => startPage(story.projectId, parent?.noteId ?? null)}
                  onAddNote={(story) => startListItem("note", story)}
                  onAddAnchor={(story) => startListItem("anchor", story)}
                  onCreateAnchors={(story) =>
                    onAddSection(story, {
                      choice: "anchors",
                      name: t("creative.workshop.anchorsName"),
                    })
                  }
                  onMoved={bumpData}
                  activeNoteId={activeNoteId}
                  stats={stats}
                  anchorOrder={anchorView.order}
                  anchorCreated={anchorCreated}
                  onReorderAnchors={anchorView.save}
                  draft={draft}
                  onCommitDraft={commitDraft}
                  onCancelDraft={() => setDraft(null)}
                >
                  <WorldSection
                    categories={categories}
                    itemsByCategory={itemsByCategory}
                    stories={scope.stories}
                    selectedStoryId={selectedStory?.projectId ?? null}
                    references={references}
                    groupContext={groupContext}
                    hasUniverse={scope.collection !== null}
                    sharedProjectId={scope.collection?.projectId ?? null}
                    worldScope={worldScope}
                    onWorldScope={(next) => {
                      setWorldScope(next)
                      remember({ world: next })
                    }}
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
          {/* Right-click on empty space: make something right there. */}
          {/* Focus is not given back to the row on close: the item picked may start a row to type
              in, and a restored focus would take it away and cancel that row. */}
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
