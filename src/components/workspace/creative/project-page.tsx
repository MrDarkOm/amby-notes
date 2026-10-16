import * as React from "react"
import {
  AlertTriangle,
  BookOpen,
  Feather,
  Globe2,
  Library,
  Lock,
  Plus,
  Settings,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import { useDatabaseStore } from "../database/database-store"
import { CreateProjectDialog, type CreatedItemResult } from "./create-project-dialog"
import { CreateSectionDialog } from "./create-section-dialog"
import { PageHeader } from "./page-header"
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
import { useProjectStore } from "./project-store"
import {
  groupSections,
  projectTargetTitle,
  resolveProjectTarget,
  toSidebarSection,
  type ProjectTarget,
  type SidebarGroup,
  type SidebarSection,
} from "./project-tree-model"
import { sectionRoleIcon } from "./section-icons"
import { useStoryLinks } from "./use-story-links"
import { useTextStats } from "./use-text-stats"

export interface SectionDatabaseProps {
  databaseId: string
  title: string
  /** The project is open for reading only: nothing about the section may be written. */
  readOnly: boolean
  /** Slot at the right of the section tabs row for the database's compact settings button. */
  toolbarHost?: HTMLElement | null
}

interface ProjectPageProps {
  projectId: string
  /** Renders one section as the ordinary database workspace (supplied by the shell). */
  renderDatabase: (database: SectionDatabaseProps) => React.ReactNode
  onOpenProject: (projectId: string, sectionId?: string) => void
  /** Opens one page of the text (the desk's "continue with"). */
  onOpenNote?: (noteId: string) => void
  /** The vault the story lives in: what the manuscript is read from. */
  vaultPath?: string | null
  /** Refreshes the file tree and the databases after a section was written. */
  onChanged?: () => Promise<void>
  /** The name the page has now (the universe's, once read), for the tab that shows it. */
  onTitle?: (title: string) => void
}

/** What the page of a target lists: the story, the universe, or the standalone stories. */
function scopeOf(target: ProjectTarget | null): PanelFilter | null {
  if (!target || target.kind === "workshop") return null
  if (target.kind === "story") return { kind: "story", storyId: target.story.storyId }
  if (target.kind === "universe") return { kind: "universe", universeId: target.universeId }
  return { kind: "standalone" }
}

function SectionCard({
  section,
  onOpen,
}: {
  section: SidebarSection
  onOpen: (section: SidebarSection) => void
}) {
  const { t } = useTranslation()
  const Icon = sectionRoleIcon(section.role)
  const missing = section.state === "missing"
  const roleName = section.role ? t(`creative.sections.${section.role}`, { defaultValue: "" }) : ""
  const subtitle = missing
    ? t("creative.page.sectionMissing")
    : section.state === "moved"
      ? t("creative.page.sectionMoved", { path: section.resolvedPath })
      : roleName && roleName !== section.name
        ? roleName
        : ""
  return (
    <button
      type="button"
      onClick={() => onOpen(section)}
      className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/40 hover:bg-accent/30"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{section.name}</span>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
      {missing && <AlertTriangle className="ml-auto size-4 shrink-0 text-amber-600" />}
    </button>
  )
}

export function ProjectPage({
  projectId,
  renderDatabase,
  onOpenProject,
  onOpenNote,
  vaultPath = null,
  onChanged,
  onTitle,
}: ProjectPageProps) {
  const { t } = useTranslation()
  const status = useProjectStore((state) => state.status)
  const catalog = useProjectStore((state) => state.catalog)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const selected = useCreativeNavStore((state) => state.sectionByProject[projectId])
  const showSection = useCreativeNavStore((state) => state.showSection)
  const [addingSection, setAddingSection] = React.useState(false)
  const [addingStory, setAddingStory] = React.useState(false)
  const [editingSettings, setEditingSettings] = React.useState(false)
  const [toolbarHost, setToolbarHost] = React.useState<HTMLDivElement | null>(null)
  // The anchors may need a relation to a base that was just made; a failure is shown, not lost.
  const { ensureAnchorLinks } = usePlotEnsurer(onChanged)
  const { putStoryInUniverse } = useStoryLinks(onChanged)
  const [linkNotice, setLinkNotice] = React.useState<string | null>(null)

  const target = React.useMemo(() => resolveProjectTarget(catalog, projectId), [catalog, projectId])
  const workshop = target?.workshop ?? null
  const scope = scopeOf(target)
  const story = target?.kind === "story" ? target.story : null

  // A universe is named by its card, which is a row of the universes section.
  const { universes } = useUniverses(target?.kind === "universe" ? workshop : null)
  const universeTitle =
    target?.kind === "universe"
      ? universes.find((universe) => universe.noteId === target.universeId)?.title
      : undefined
  const pageTitle = projectTargetTitle(target, creativeTitleLabels(t), universeTitle)
  const onTitleRef = React.useRef(onTitle)
  onTitleRef.current = onTitle
  React.useEffect(() => {
    if (target) onTitleRef.current?.(pageTitle)
  }, [pageTitle, projectId, target])

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
  const icon =
    target.kind === "story" ? (
      <BookOpen className="size-7" />
    ) : target.kind === "universe" ? (
      <Globe2 className="size-7" />
    ) : target.kind === "standalone" ? (
      <Library className="size-7" />
    ) : (
      <IconValue
        value={workshop.icon ?? undefined}
        fallback={<Feather className="size-7" />}
        className="size-8 rounded-md"
      />
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
      : target.kind === "workshop"
        ? scopeCounts([
            stories.length > 0
              ? t("creative.workshop.storiesCount", { count: stories.length })
              : null,
            sections.length > 0
              ? t("creative.page.sectionsCount", { count: sections.length })
              : null,
          ])
        : scopeData.loading
          ? null
          : scopeCounts([
              t("creative.workshop.storiesCount", { count: scopeData.stories.length }),
              target.kind === "universe"
                ? t("creative.page.eventsCount", { count: scopeData.events.length })
                : null,
            ])

  const hasSettings = !workshop.readOnly && (isWorkshop || target.kind === "story")
  const openNote = onOpenNote ?? (() => undefined)
  const openStory = (storyId: string) => onOpenProject(storyId)

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
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--note-surface)]">
      <header className="flex shrink-0 flex-col gap-3 px-4 pb-2 pt-6 sm:px-8">
        <PageHeader
          icon={icon}
          title={pageTitle}
          kind={kindLabel}
          meta={meta}
          tags={isWorkshop ? workshop.tags : []}
          actions={
            hasSettings ? (
              <>
                {isWorkshop && (
                  <Button variant="outline" size="sm" onClick={() => setAddingSection(true)}>
                    <Plus className="size-3.5" />
                    {t("creative.panel.newSection")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  aria-label={t("creative.page.settings")}
                  title={t("creative.page.settings")}
                  onClick={() => setEditingSettings(true)}
                >
                  <Settings className="size-4" />
                </Button>
              </>
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
              onClick={() => showSection(projectId, OVERVIEW_SECTION)}
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
                      onClick={() => showSection(projectId, section.id)}
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
          <div ref={setToolbarHost} className="ml-auto flex shrink-0 items-center" />
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
        ) : activeSection && isWorkshop ? (
          <div key={activeSection.databaseId} className="flex min-h-0 flex-1 flex-col">
            {renderDatabase({
              databaseId: activeSection.databaseId,
              title: activeSection.name,
              readOnly: workshop.readOnly,
              toolbarHost,
            })}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-10 pt-4 sm:px-8">
            {activeSource && scope ? (
              <ScopedSection
                key={activeSource.id}
                workshop={workshop}
                section={activeSource}
                scope={scope}
                data={scopeData}
                onOpenNote={openNote}
                onOpenWhole={(sectionId) => onOpenProject(workshop.workshopId, sectionId)}
              />
            ) : target.kind === "story" ? (
              textDatabaseId ? (
                <ProjectDesk
                  story={target.story}
                  workshop={workshop}
                  vaultPath={vaultPath}
                  onOpenNote={openNote}
                  onOpenSection={(sectionId) => showSection(projectId, sectionId)}
                  stats={textStats}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t("creative.workshop.noText")}</p>
              )
            ) : target.kind === "workshop" ? (
              <>
                {stories.length > 0 && (
                  <section className="mb-8">
                    <h2 className="mb-3 text-sm font-semibold">{t("creative.page.stories")}</h2>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {stories.map((st) => (
                        <button
                          key={st.storyId}
                          type="button"
                          onClick={() => openStory(st.storyId)}
                          className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/40 hover:bg-accent/30"
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                            <BookOpen className="size-5" />
                          </span>
                          <span className="min-w-0 break-words text-sm font-medium">{st.name}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {groups.map((group) => (
                  <section key={group.id} className="mb-8">
                    {group.id !== "custom" && (
                      <h2 className="mb-3 text-sm font-semibold">
                        {t(`creative.page.groups.${group.id}`)}
                      </h2>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {group.sections.map((section) => (
                        <SectionCard
                          key={section.id}
                          section={section}
                          onOpen={(opened) => showSection(projectId, opened.id)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
                {sections.length === 0 && stories.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t("creative.page.noSections")}</p>
                )}
              </>
            ) : (
              scope &&
              (scope.kind === "universe" || scope.kind === "standalone") && (
                <ScopeDesk
                  workshop={workshop}
                  scope={scope}
                  data={scopeData}
                  onOpenNote={openNote}
                  onOpenStory={openStory}
                  onOpenSection={(sectionId) => showSection(projectId, sectionId)}
                  onNewStory={workshop.readOnly ? null : () => setAddingStory(true)}
                  onEnsureAnchorLinks={ensureAnchorLinks}
                />
              )
            )}
          </div>
        )}
      </div>

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
              showSection(projectId, created.section.sectionId)
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
