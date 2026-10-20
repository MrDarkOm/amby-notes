import * as React from "react"
import {
  AlertTriangle,
  Columns2,
  Feather,
  FolderOpen,
  LayoutDashboard,
  Lock,
  NotebookPen,
  Plus,
  Rows2,
  Settings,
  SquareArrowOutUpRight,
  Star,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import type { StorySummary } from "@/lib/storage"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { EDITOR_CONTENT_WIDTH } from "@/lib/themes"
import { IconValue } from "../icon-value"
import { useDatabaseStore } from "../database/database-store"
import type { ContentWidth } from "../app-config"
import { PageFloatingBar } from "../page-chrome/page-floating-bar"
import { PageHeaderBar } from "../page-chrome/page-header-bar"
import { bottomBarMenuItem, contentWidthMenuItem } from "../page-chrome/page-menu-items"
import type { PageFocusTabs, PageMenuGroup } from "../page-chrome/page-chrome-types"
import { useSettingsStore } from "../use-settings-store"
import { useViewStateStore } from "../use-view-state-store"
import { formatModified } from "../workspace-tree-utils"
import { CreateProjectDialog, type CreatedItemResult } from "./create-project-dialog"
import { CreateSectionDialog } from "./create-section-dialog"
import { PageHeader } from "./page-header"
import { ScopeNumbers, WorkshopNumbers } from "./pages/page-numbers"
import { WorkshopOverview } from "./pages/workshop-overview"
import { WorkshopSection } from "./pages/workshop-section"
import { useStoriesStats } from "./pages/use-stories-stats"
import { creativeFileId } from "./creative-history"
import { creativeCrumbs } from "./page-crumbs"
import { creativeTitleLabels } from "./project-labels"
import { ProjectDesk } from "./project-desk"
import { ProjectSettingsDialog } from "./project-settings-dialog"
import { ScopeDesk } from "./scope-desk"
import { ScopedSection } from "./scoped-section"
import { usePlotEnsurer } from "./workshop/use-ensure-plot"
import { projectErrorText } from "./project-error"
import { useScopeData } from "./workshop/use-scope-data"
import { useUniverses } from "./workshop/use-universes"
import { scopeSections, type PanelFilter } from "./workshop/workshop-model"
import { OVERVIEW_SECTION, useCreativeNavStore } from "./creative-nav-store"
import { readWorkshopPrefs, writeWorkshopPrefs } from "./creative-scope-storage"
import type { DeskItem } from "./desk/desk-layout-model"
import { useProjectStore } from "./project-store"
import {
  groupSections,
  projectTargetTitle,
  resolveProjectTarget,
  toSidebarSection,
  type ProjectTarget,
  type SidebarGroup,
} from "./project-tree-model"
import { projectTargetIcon, sectionRoleIcon } from "./section-icons"
import { useStoryLinks } from "./use-story-links"
import { useStoryUniverse } from "./use-story-universe"
import { useTextStats } from "./use-text-stats"

interface ProjectPageProps {
  projectId: string
  /** Opens one section's database the ordinary way, as a tab of its own (supplied by the shell). */
  onOpenDatabase: (databaseId: string, title: string) => void
  onOpenProject: (projectId: string, sectionId?: string) => void
  /** Opens one page of the text (the desk's "continue with"). */
  onOpenNote?: (noteId: string) => void
  /** The vault the story lives in: what the manuscript is read from. */
  vaultPath?: string | null
  /** Refreshes the file tree and the databases after a section was written. */
  onChanged?: () => Promise<void>
  /** The name the page has now (the universe's, once read), for the tab that shows it. */
  onTitle?: (title: string) => void
  /**
   * The section tab this page's entry in the tab history names (`null`: the overview). With
   * `onShowSection` the tab's history owns it, so Back returns to the section before; without
   * them the page keeps its own memory of the section.
   */
  section?: string | null
  onShowSection?: (sectionId: string) => void
  /** What the shell gives the page's header and bar: history, focus, tab and file actions. */
  host?: CreativePageHost
}

/** What the shell hands every workshop page for the shared header and the floating bar. */
export interface CreativePageHost {
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  isFocusMode?: boolean
  onToggleFocusMode?: () => void
  /** The tab menu that names the page in focus mode. */
  focusTabs?: Omit<PageFocusTabs, "title">
  onOpenInNewTab?: () => void
  onSplitRight?: () => void
  onSplitDown?: () => void
  /** Stars or unstars a note (the shared favorites of Amby). */
  onToggleFavorite?: (noteId: string) => void
  /** Shows a folder of the vault (vault-relative; empty is the vault itself) in the file manager. */
  onShowInExplorer?: (vaultPath: string) => void
}

const NO_STORIES: readonly StorySummary[] = []

/** What the page of a target lists: the story, the universe, or the standalone stories. */
function scopeOf(target: ProjectTarget | null): PanelFilter | null {
  if (!target || target.kind === "workshop") return null
  if (target.kind === "story") return { kind: "story", storyId: target.story.storyId }
  if (target.kind === "universe") return { kind: "universe", universeId: target.universeId }
  return { kind: "standalone" }
}

export function ProjectPage({
  projectId,
  onOpenDatabase,
  onOpenProject,
  onOpenNote,
  vaultPath = null,
  onChanged,
  onTitle,
  section,
  onShowSection,
  host,
}: ProjectPageProps) {
  const { t } = useTranslation()
  const status = useProjectStore((state) => state.status)
  const catalog = useProjectStore((state) => state.catalog)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const memorySection = useCreativeNavStore((state) => state.sectionByProject[projectId])
  const rememberSection = useCreativeNavStore((state) => state.showSection)
  // The tab's history names the section when the shell hands it in; otherwise the page remembers it.
  const selected = onShowSection ? (section ?? OVERVIEW_SECTION) : memorySection
  const showSection = (id: string) => {
    if (onShowSection) onShowSection(id)
    else rememberSection(projectId, id)
  }
  const pageKey = creativeFileId(projectId)
  const favorites = useViewStateStore((state) => state.favorites)
  const locked = useViewStateStore((state) => state.lockedFileIds.has(pageKey))
  const toggleLock = useViewStateStore((state) => state.toggleLock)
  const storedWidth = useViewStateStore((state) => state.contentWidths?.[pageKey])
  const setContentWidth = useViewStateStore((state) => state.setContentWidth)
  const showAreaControls = useSettingsStore((state) => state.prefs.editor.showAreaControls ?? true)
  const compileRef = React.useRef<(() => void) | null>(null)
  // A page of the workshop is a dashboard: unless the author chose a width, it uses the whole one.
  const contentWidth: ContentWidth = storedWidth ?? "full"
  const [addingSection, setAddingSection] = React.useState(false)
  const [addingStory, setAddingStory] = React.useState(false)
  const [editingSettings, setEditingSettings] = React.useState(false)
  const [customizingDesk, setCustomizingDesk] = React.useState(false)
  // One layout of the desk for every story, kept per vault.
  const [deskLayout, setDeskLayout] = React.useState<DeskItem[] | undefined>(() =>
    vaultPath ? readWorkshopPrefs(vaultPath).deskLayout : undefined,
  )
  const changeDeskLayout = (next: DeskItem[]) => {
    setDeskLayout(next)
    if (vaultPath) writeWorkshopPrefs(vaultPath, { deskLayout: next })
  }
  // The anchors may need a relation to a base that was just made; a failure is shown, not lost.
  const { ensureAnchorLinks } = usePlotEnsurer(onChanged)
  const { putStoryInUniverse } = useStoryLinks(onChanged)
  const [linkNotice, setLinkNotice] = React.useState<string | null>(null)

  const target = React.useMemo(() => resolveProjectTarget(catalog, projectId), [catalog, projectId])
  const workshop = target?.workshop ?? null
  const scope = scopeOf(target)
  const story = target?.kind === "story" ? target.story : null

  // A universe is named by its card, which is a row of the universes section; the workshop's
  // page counts them and names them on its stories' cards.
  const { universes } = useUniverses(
    target?.kind === "universe" || target?.kind === "workshop" || target?.kind === "story"
      ? workshop
      : null,
  )
  const storyUniverseId = useStoryUniverse(workshop, target?.kind === "story" ? target.story : null)
  const universeTitle =
    target?.kind === "universe"
      ? universes.find((universe) => universe.noteId === target.universeId)?.title
      : undefined
  const pageTitle = projectTargetTitle(target, creativeTitleLabels(t), universeTitle)
  const onTitleRef = React.useRef(onTitle)
  onTitleRef.current = onTitle
  React.useEffect(() => {
    if (target) onTitleRef.current?.(pageTitle)
  }, [pageTitle, projectId, target, selected])

  // The tabs: the whole shared lists on the workshop's page; on the page of a story, a universe or
  // the standalone stories only the lists that can hold their pages, each showing what belongs here.
  const groups = React.useMemo<SidebarGroup[]>(() => {
    if (!workshop) return []
    if (target?.kind === "workshop") return groupSections(workshop)
    return [
      {
        id: "custom",
        sections: scopeSections(workshop).map((section) => toSidebarSection(workshop, section)),
      },
    ]
  }, [target?.kind, workshop])
  const sections = groups.flatMap((group) => group.sections)
  const active =
    selected && sections.some((section) => section.id === selected) ? selected : OVERVIEW_SECTION
  const activeSection = sections.find((section) => section.id === active)
  const activeSource = workshop?.sections.find((section) => section.id === activeSection?.id)

  // A story's overview reads its own rows; its section lists are read only when one is open.
  const scopeData = useScopeData(
    workshop,
    scope && (scope.kind !== "story" || activeSection) ? scope : null,
  )
  const textDatabaseId = story?.text?.databaseId ?? null
  const textStats = useTextStats(textDatabaseId, dataNonce)
  // The workshop's page counts the words of every story and shows their cards.
  // A universe's page and the standalone page count the stories of their own scope.
  const statsStories =
    target?.kind === "workshop"
      ? (workshop?.stories ?? NO_STORIES)
      : target?.kind === "universe" || target?.kind === "standalone"
        ? scopeData.stories
        : NO_STORIES
  const storiesStats = useStoriesStats(statsStories, dataNonce)

  if (!target || !workshop) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--note-surface)] p-8">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <Feather className="size-7 text-muted-foreground" />
          <h2 className="text-base font-semibold">
            {status === "ready" || status === "error"
              ? t("creative.page.notFoundTitle")
              : t("common.loading")}
          </h2>
          {(status === "ready" || status === "error") && (
            <p className="text-sm text-muted-foreground">{t("creative.page.notFoundHint")}</p>
          )}
        </div>
      </div>
    )
  }

  const isWorkshop = target.kind === "workshop"
  const stories = workshop.stories

  const kindLabel =
    target.kind === "story"
      ? t("creative.kind.story")
      : target.kind === "universe"
        ? t("creative.kind.universe")
        : target.kind === "standalone"
          ? t("creative.page.standalone.kind")
          : t("creative.welcome.title")
  const TargetIcon = projectTargetIcon(target.kind)
  const icon =
    target.kind === "workshop" ? (
      <IconValue
        value={workshop.icon ?? undefined}
        fallback={<TargetIcon className="size-7" />}
        className="size-8 rounded-md"
      />
    ) : (
      <TargetIcon className="size-7" />
    )

  const words = Object.values(textStats).reduce((total, stat) => total + stat.wordCount, 0)
  const pages = Object.keys(textStats).length
  const scopeCounts = (parts: (string | null)[]) => parts.filter(Boolean).join(" · ")
  const meta =
    target.kind === "story"
      ? pages > 0
        ? scopeCounts([
            t("creative.workshop.pagesShort", { count: pages }),
            t("docEditor.wordCount", { count: words }),
          ])
        : null
      : null
  const wordsWritten = Object.values(storiesStats.stats).reduce(
    (total, stat) => total + stat.words,
    0,
  )

  // The desk's layout is the interface's own (one for every story), so a read-only workshop may
  // arrange it too; it only has a desk while the story's overview is open.
  const canCustomizeDesk =
    target.kind === "story" && active === OVERVIEW_SECTION && Boolean(textDatabaseId)
  const hasSettings = !workshop.readOnly && (isWorkshop || target.kind === "story")
  const openNote = onOpenNote ?? (() => undefined)
  const openStory = (storyId: string) => onOpenProject(storyId)
  // Read mode is a story's: it keeps the desk from being changed by a stray click or drag.
  const readMode = target.kind === "story" && locked
  const customizing = customizingDesk && !readMode

  // The header: the trail of the page, and the menu of what can be done with it.
  const universeNameOf = (noteId: string) =>
    universes.find((universe) => universe.noteId === noteId)?.title
  const crumbs = creativeCrumbs({
    target,
    workshopLabel: t("panels.creative"),
    standaloneLabel: t("creative.workshop.standalone"),
    pageTitle,
    storyUniverse: storyUniverseId
      ? { id: storyUniverseId, title: universeNameOf(storyUniverseId) }
      : null,
    universeFallback: t("creative.kind.universe"),
    sectionName: activeSection?.name ?? null,
    open: (id) => onOpenProject(id),
  })
  // The page's own note, which can be starred: a story's card and a universe's card.
  const pageNoteId =
    target.kind === "story"
      ? story?.cardNoteId
      : target.kind === "universe"
        ? target.universeId
        : null
  const isFavorite = pageNoteId ? favorites.has(pageNoteId) : false
  const icon16 = (Icon: React.ComponentType<{ className?: string }>) => (
    <Icon className="size-3.5 text-muted-foreground" />
  )
  const folderPath = story ? story.folderPath : workshop.path
  const canCompile = target.kind === "story" && canCustomizeDesk && Boolean(vaultPath)
  const menuGroups: PageMenuGroup[] = [
    [
      contentWidthMenuItem(t, contentWidth, (width) => setContentWidth(pageKey, width)),
      bottomBarMenuItem(t, showAreaControls),
      ...(canCustomizeDesk && !readMode
        ? [
            {
              id: "customize-desk",
              label: t("creative.desk.customize"),
              icon: icon16(LayoutDashboard),
              checked: customizing,
              onSelect: () => setCustomizingDesk((on) => !on),
            },
          ]
        : []),
      ...(canCompile
        ? [
            {
              id: "compile",
              label: t("creative.page.desk.compile"),
              icon: icon16(NotebookPen),
              onSelect: () => compileRef.current?.(),
            },
          ]
        : []),
      ...(isWorkshop && activeSection && activeSection.state !== "missing"
        ? [
            {
              id: "open-as-base",
              label: t("creative.gallery.openAsBase"),
              icon: icon16(FolderOpen),
              onSelect: () => onOpenDatabase(activeSection.databaseId, activeSection.name),
            },
          ]
        : []),
    ],
    [
      ...(pageNoteId
        ? [
            {
              id: "favorite",
              label: isFavorite ? t("tree.removeBookmark") : t("tree.addBookmark"),
              icon: isFavorite ? (
                <Star className="size-3.5 fill-current text-primary" />
              ) : (
                icon16(Star)
              ),
              disabled: !host?.onToggleFavorite,
              onSelect: () => host?.onToggleFavorite?.(pageNoteId),
            },
          ]
        : []),
      {
        id: "open-in-new-tab",
        label: t("tree.openInNewTab"),
        icon: icon16(SquareArrowOutUpRight),
        disabled: !host?.onOpenInNewTab,
        onSelect: host?.onOpenInNewTab,
      },
      ...(host?.onSplitRight
        ? [
            {
              id: "split-right",
              label: t("tabs.splitRight"),
              icon: icon16(Columns2),
              onSelect: host.onSplitRight,
            },
          ]
        : []),
      ...(host?.onSplitDown
        ? [
            {
              id: "split-down",
              label: t("tabs.splitDown"),
              icon: icon16(Rows2),
              onSelect: host.onSplitDown,
            },
          ]
        : []),
    ],
    [
      {
        id: "show-in-explorer",
        label: t("tree.showInExplorer"),
        icon: icon16(FolderOpen),
        disabled: !host?.onShowInExplorer,
        onSelect: () => host?.onShowInExplorer?.(folderPath),
      },
      ...(hasSettings
        ? [
            {
              id: "settings",
              label: t("creative.page.settings"),
              icon: icon16(Settings),
              onSelect: () => setEditingSettings(true),
            },
          ]
        : []),
    ],
  ]

  // The floating bar: when the page last changed and its words; a story also has the read-mode lock
  // and the layout of its desk.
  const lastChange =
    target.kind === "story"
      ? Object.values(textStats).reduce<number | null>(
          (latest, stat) =>
            stat.modified != null && stat.modified > (latest ?? 0) ? stat.modified : latest,
          null,
        )
      : Object.values(storiesStats.stats).reduce<number | null>(
          (latest, stat) =>
            stat.lastModified != null && stat.lastModified > (latest ?? 0)
              ? stat.lastModified
              : latest,
          null,
        )
  const barWords = target.kind === "story" ? words : wordsWritten
  const pageWidth = { maxWidth: EDITOR_CONTENT_WIDTH[contentWidth] }

  const tabClass = (isActive: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
      isActive
        ? "bg-slate-100 text-slate-900 dark:bg-accent dark:text-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    )

  const storyCreated = (created: CreatedItemResult) => {
    void (async () => {
      await onChanged?.()
      await useProjectStore.getState().refresh?.()
      if (target.kind === "universe") {
        // Born in the universe. A failure never undoes the story: it stays among the standalone
        // ones, the page says why and does not leave.
        try {
          await putStoryInUniverse(created, target.universeId, workshop.workshopId)
        } catch (caught) {
          setLinkNotice(
            t("creative.workshop.link.storyUniverseFailed", {
              message: projectErrorText(t, caught),
            }),
          )
          bumpData()
          return
        }
      }
      bumpData()
      openStory(created.id)
    })()
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-[var(--note-surface)]">
      <PageHeaderBar
        crumbs={crumbs}
        showHistory
        onBack={host?.onBack}
        onForward={host?.onForward}
        canGoBack={host?.canGoBack}
        canGoForward={host?.canGoForward}
        backLabel={t("graph.back")}
        forwardLabel={t("graph.forward")}
        isFocusMode={host?.isFocusMode}
        onToggleFocusMode={host?.onToggleFocusMode}
        focus={{ tabs: [], ...host?.focusTabs, title: pageTitle }}
        menu={{ groups: menuGroups }}
      />
      <header
        className="mx-auto flex w-full shrink-0 flex-col gap-3 px-4 pb-2 pt-4 sm:px-8"
        style={pageWidth}
      >
        <PageHeader
          icon={icon}
          title={pageTitle}
          kind={kindLabel}
          meta={meta}
          tags={isWorkshop ? workshop.tags : []}
          below={
            isWorkshop ? (
              <WorkshopNumbers
                worlds={universes.length}
                stories={stories.length}
                words={wordsWritten}
              />
            ) : (target.kind === "universe" || target.kind === "standalone") &&
              !scopeData.loading ? (
              <ScopeNumbers stories={scopeData.stories.length} words={wordsWritten} />
            ) : undefined
          }
          actions={
            hasSettings && isWorkshop ? (
              <Button variant="outline" size="sm" onClick={() => setAddingSection(true)}>
                <Plus className="size-3.5" />
                {t("creative.panel.newSection")}
              </Button>
            ) : undefined
          }
        />
        {workshop.readOnly && (
          <p className="flex items-center gap-2 rounded-md border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            {t("creative.page.readOnlyBanner", { version: workshop.formatVersion })}
          </p>
        )}
        <div className="flex min-w-0 items-center gap-2 pb-1">
          <nav
            aria-label={t("creative.page.sections")}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          >
            <button
              type="button"
              className={tabClass(active === OVERVIEW_SECTION)}
              aria-current={active === OVERVIEW_SECTION ? "page" : undefined}
              onClick={() => showSection(OVERVIEW_SECTION)}
            >
              {story ? t("creative.page.desk.title") : t("creative.page.overview")}
            </button>
            {groups.map((group) => (
              <React.Fragment key={group.id}>
                <span
                  aria-hidden="true"
                  title={group.id === "custom" ? undefined : t(`creative.page.groups.${group.id}`)}
                  className="mx-1.5 h-4 w-px shrink-0 self-center bg-border"
                />
                {group.sections.map((section) => {
                  const Icon = sectionRoleIcon(section.role)
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={tabClass(active === section.id)}
                      aria-current={active === section.id ? "page" : undefined}
                      onClick={() => showSection(section.id)}
                    >
                      <Icon className="size-3.5" />
                      {section.name}
                      {section.state === "missing" && (
                        <AlertTriangle className="size-3 text-amber-600 dark:text-amber-500" />
                      )}
                    </button>
                  )
                })}
              </React.Fragment>
            ))}
          </nav>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {linkNotice && (
          <div
            role="alert"
            className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive sm:mx-8"
          >
            <span className="min-w-0 flex-1 break-words">{linkNotice}</span>
            <button
              type="button"
              className="shrink-0 underline"
              onClick={() => setLinkNotice(null)}
            >
              {t("common.close")}
            </button>
          </div>
        )}
        {activeSection && activeSection.state === "missing" ? (
          <div className="m-4 flex flex-col gap-1 rounded-xl border border-dashed border-border p-6 text-sm sm:m-8">
            <p className="font-medium">{t("creative.page.sectionMissing")}</p>
            <p className="text-muted-foreground">{t("creative.page.sectionMissingHint")}</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto w-full px-4 pb-10 pt-4 sm:px-8" style={pageWidth}>
              {activeSource && isWorkshop ? (
                <WorkshopSection
                  key={activeSource.id}
                  workshop={workshop}
                  section={activeSource}
                  onOpenNote={openNote}
                />
              ) : activeSource && scope ? (
                <ScopedSection
                  key={activeSource.id}
                  workshop={workshop}
                  section={activeSource}
                  scope={scope}
                  data={scopeData}
                  onOpenNote={openNote}
                  onOpenWhole={(sectionId) => onOpenProject(workshop.workshopId, sectionId)}
                  locked={readMode}
                />
              ) : target.kind === "story" ? (
                textDatabaseId ? (
                  <ProjectDesk
                    story={target.story}
                    workshop={workshop}
                    vaultPath={vaultPath}
                    onOpenNote={openNote}
                    onOpenSection={(sectionId) => showSection(sectionId)}
                    onChanged={onChanged}
                    layout={deskLayout}
                    editing={customizing}
                    onLayoutChange={changeDeskLayout}
                    stats={textStats}
                    locked={readMode}
                    compileRef={compileRef}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{t("creative.workshop.noText")}</p>
                )
              ) : target.kind === "workshop" ? (
                <WorkshopOverview
                  workshop={workshop}
                  vaultPath={vaultPath}
                  storiesStats={storiesStats}
                  universes={universes}
                  onOpenStory={openStory}
                  onOpenNote={openNote}
                  onNewStory={workshop.readOnly ? null : () => setAddingStory(true)}
                />
              ) : (
                scope &&
                (scope.kind === "universe" || scope.kind === "standalone") && (
                  <ScopeDesk
                    workshop={workshop}
                    scope={scope}
                    data={scopeData}
                    storiesStats={storiesStats}
                    vaultPath={vaultPath}
                    universeTitle={universeTitle}
                    onOpenNote={openNote}
                    onOpenStory={openStory}
                    onOpenWhole={(sectionId) => onOpenProject(workshop.workshopId, sectionId)}
                    onNewStory={workshop.readOnly ? null : () => setAddingStory(true)}
                    onEnsureAnchorLinks={ensureAnchorLinks}
                  />
                )
              )}
            </div>
          </div>
        )}
      </div>

      <PageFloatingBar
        hidden={!showAreaControls}
        modified={
          lastChange !== null
            ? t("creative.storyCard.edited", { when: formatModified(lastChange) })
            : undefined
        }
        wordCount={t("docEditor.wordCount", { count: barWords })}
        lock={
          target.kind === "story"
            ? {
                locked,
                onToggle: () => toggleLock(pageKey),
                title: locked ? t("docEditor.editMode") : t("docEditor.viewMode"),
              }
            : undefined
        }
        settings={
          canCustomizeDesk && !readMode
            ? {
                title: customizing
                  ? t("creative.desk.customizeDone")
                  : t("creative.desk.customize"),
                active: customizing,
                toggle: true,
                onClick: () => setCustomizingDesk((on) => !on),
              }
            : undefined
        }
      />

      {addingStory && (
        <CreateProjectDialog
          open
          onClose={() => setAddingStory(false)}
          vaultGeneration={vaultGeneration}
          workshop={workshop}
          kinds={["story"]}
          initialKind="story"
          onCreated={storyCreated}
        />
      )}

      {addingSection && (
        <CreateSectionDialog
          open
          onClose={() => setAddingSection(false)}
          vaultGeneration={vaultGeneration}
          workshop={workshop}
          onCreated={(created) => {
            void (async () => {
              await onChanged?.()
              await useProjectStore.getState().refresh?.()
              try {
                await ensureAnchorLinks(workshop.workshopId)
              } catch (caught) {
                setLinkNotice(
                  t("creative.plot.linksFailed", { message: projectErrorText(t, caught) }),
                )
              }
              showSection(created.section.sectionId)
            })()
          }}
        />
      )}

      {editingSettings && (
        <ProjectSettingsDialog
          open
          onClose={() => setEditingSettings(false)}
          vaultGeneration={vaultGeneration}
          workshop={workshop}
          story={story}
          onChanged={onChanged}
          onAddSection={() => setAddingSection(true)}
        />
      )}
    </div>
  )
}
