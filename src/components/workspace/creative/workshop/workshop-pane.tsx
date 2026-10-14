import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  createDatabaseRow,
  createTextPage,
  type CreatedTextPage,
  type ProjectCatalog,
  type WorkshopSummary,
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
  selectedStoryOf,
  storySection,
  workshopScope,
  type EntityItem,
  type GroupContext,
  type WorkshopDraft,
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
  /** Creates a page in a world category under the name the author typed; rejects on failure. */
  onCreateEntity: (categoryKey: string, title: string) => Promise<void>
  /** What a page's own menu can do besides opening it. */
  itemActions: Pick<ItemActions, "onOpenInNewTab" | "onRename" | "onDelete" | "onDeleteMany">
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
  itemActions,
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
  const selectedStory = rawFilter === "all" ? null : selectedStoryOf(scope.stories, rawFilter)
  const searching = search.trim() !== ""

  const databaseIds = React.useMemo(() => {
    const ids: string[] = []
    if (selectedStory?.databaseId) ids.push(selectedStory.databaseId)
    if (searching) {
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
      if (univSec) ids.push(univSec.databaseId)
    }
    for (const category of categories) {
      ids.push(category.databaseId)
    }
    return ids
  }, [categories, scope.stories, scope.workshop, searching, selectedStory])

  const data = useDatabaseRows(databaseIds, dataNonce)
  const stats = useTextStats(selectedStory?.databaseId, dataNonce)

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
  const startListItem = (kind: "note" | "anchor") => {
    setSearch("")
    showPart(kind === "note" ? "notes" : "anchors")
    setDraft({ kind })
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
      await onCreateEntity(draft.categoryKey, title)
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
    const sec = storySection(scope.workshop, draft.kind === "note" ? "notes" : "anchors")
    if (!sec) throw new Error(t("creative.errors.projectNotFound"))
    const created = await createDatabaseRow({
      expectedGeneration: vaultGeneration,
      databaseId: sec.databaseId,
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
                  selectedUniverseId={universeFilter}
                  onSelectStory={(storyId) => {
                    setDraft(null)
                    setStoryFilter(storyId)
                    remember({ story: storyId })
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
                  onAddNote={() => startListItem("note")}
                  onAddAnchor={() => startListItem("anchor")}
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
