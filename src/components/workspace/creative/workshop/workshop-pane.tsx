import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  createDatabaseRow,
  type CreatedTextPage,
  type ProjectCatalog,
  type ProjectSummary,
} from "@/lib/storage"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { PanelSearch } from "../../panels/panel-header"
import type { ChooserOption, CreateChoice } from "../chooser-options"
import { useDatabaseStore } from "../../database/database-store"
import { useCreativeNavStore } from "../creative-nav-store"
import { writeWorkshopPrefs } from "../creative-scope-storage"
import { CreatePageDialog } from "./create-page-dialog"
import { SearchResults } from "./search-results"
import { buildTextTree, type TextNode } from "./text-tree-model"
import { useDatabaseRows } from "./use-database-rows"
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
} from "./workshop-model"

interface WorkshopPaneProps {
  catalog: ProjectCatalog
  /** The resolved scope: a collection's project ID, or `null` for stand-alone stories. */
  scopeId: string | null
  vault: string | null
  vaultGeneration: number | null
  onOpenNote: (noteId: string) => void
  onOpenProject: (projectId: string) => void
  /** `options` prefill the dialog: the anchors section a story does not have yet. */
  onAddSection: (project: ProjectSummary, options?: { choice: "anchors"; name: string }) => void
  /** Adds a page to a world category: asked for from the "+" of its row. */
  onAddEntity: (categoryKey: string) => void
  /** What a page's own menu can do besides opening it. */
  itemActions: Pick<ItemActions, "onOpenInNewTab" | "onRename" | "onDelete" | "onDeleteMany">
  /** The menu of the empty space: what can be created from here, the "Create" button's list. */
  createOptions: ChooserOption[]
  onCreate: (choice: CreateChoice) => void
}

/**
 * The body of the workshop panel, as one column: the search, the chosen story with its parts
 * (books, arcs, anchors, notes) and under them the world (characters, locations and the author's
 * own categories), which a switch narrows to the story or widens to the whole universe.
 */
export function WorkshopPane({
  catalog,
  scopeId,
  vault,
  vaultGeneration,
  onOpenNote,
  onOpenProject,
  onAddSection,
  onAddEntity,
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

  // A page asked for from outside (the "Create" button) opens the dialog here, where the text is.
  const [pageDialog, setPageDialog] = React.useState<{
    storyId: string | null
    parent: TextNode | null
    levelId?: string | null
  } | null>(null)
  const handledRequest = React.useRef(pageRequest?.id ?? 0)
  React.useEffect(() => {
    if (!pageRequest || pageRequest.id === handledRequest.current) return
    handledRequest.current = pageRequest.id
    setPageDialog({
      storyId: pageRequest.storyId ?? selectedStory?.projectId ?? null,
      parent: null,
    })
  }, [pageRequest, selectedStory])

  const rootsOf = React.useCallback(
    (storyId: string): TextNode[] => {
      const story = scope.stories.find((candidate) => candidate.projectId === storyId)
      const rows = story?.text?.databaseId ? data.rows[story.text.databaseId] : undefined
      return story?.text && rows ? buildTextTree(rows, story.text.properties) : []
    },
    [data.rows, scope.stories],
  )

  const remember = (patch: Parameters<typeof writeWorkshopPrefs>[1]) => {
    if (vault) writeWorkshopPrefs(vault, patch)
  }

  const createIn = async (databaseId: string | undefined) => {
    if (!databaseId || vaultGeneration === null) return
    try {
      const created = await createDatabaseRow({
        expectedGeneration: vaultGeneration,
        databaseId,
        title: t("creative.workshop.untitled"),
        template: { kind: "default" },
      })
      bumpData()
      onOpenNote(created.noteId)
    } catch {
      bumpData()
    }
  }

  const afterPage = (created: CreatedTextPage) => {
    bumpData()
    onOpenNote(created.noteId)
  }

  const iconOf = (databaseId: string) =>
    databases.find((database) => database.databaseId === databaseId)?.icon ?? null

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
                  onAddPage={(story, parent, levelId) =>
                    setPageDialog({ storyId: story.projectId, parent, levelId })
                  }
                  onAddNote={(story) => void createIn(storySection(story, "notes")?.databaseId)}
                  onAddAnchor={(story) => void createIn(storySection(story, "anchors")?.databaseId)}
                  onCreateAnchors={(story) =>
                    onAddSection(story, {
                      choice: "anchors",
                      name: t("creative.workshop.anchorsName"),
                    })
                  }
                  onMoved={bumpData}
                >
                  <WorldSection
                    categories={categories}
                    itemsByCategory={itemsByCategory}
                    stories={scope.stories}
                    selectedStoryId={selectedStory?.projectId ?? null}
                    references={references}
                    groupContext={groupContext}
                    hasUniverse={scope.collection !== null}
                    worldScope={worldScope}
                    onWorldScope={(next) => {
                      setWorldScope(next)
                      remember({ world: next })
                    }}
                    collapsed={collapsed}
                    onToggle={toggleCollapsed}
                    iconOf={iconOf}
                    status={data.status}
                    truncated={data.truncated}
                    onOpen={onOpenNote}
                    onAddEntity={onAddEntity}
                  />
                </WorksTab>
              )}
            </div>
          </ContextMenuTrigger>
          {/* Right-click on empty space: make something right there. */}
          <ContextMenuContent className="w-64 border-border bg-popover text-foreground">
            <ContextMenuLabel className="text-[11px] text-muted-foreground">
              {t("creative.workshop.menu.create")}
            </ContextMenuLabel>
            {createOptions.map(({ value, icon: Icon, title }) => (
              <ContextMenuItem
                key={value}
                className="gap-2 text-[13px]"
                onSelect={() => onCreate(value)}
              >
                <Icon className="size-3.5 text-muted-foreground" />
                <span className="truncate">{title}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
        <CreatePageDialog
          open={pageDialog !== null}
          onClose={() => setPageDialog(null)}
          vaultGeneration={vaultGeneration}
          stories={scope.stories.filter((story) => !story.readOnly && story.text?.databaseId)}
          storyId={pageDialog?.storyId ?? null}
          parent={pageDialog?.parent ?? null}
          levelId={pageDialog?.levelId ?? null}
          rootsOf={rootsOf}
          onCreated={afterPage}
        />
      </div>
    </ItemActionsContext.Provider>
  )
}
