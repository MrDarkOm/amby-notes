import * as React from "react"
import { AlertTriangle, BookOpen, Feather, Globe2, Lock, Plus, Settings } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import { useDatabaseStore } from "../database/database-store"
import { CreateSectionDialog } from "./create-section-dialog"
import { ProjectDesk } from "./project-desk"
import { ProjectSettingsDialog } from "./project-settings-dialog"
import { UniverseDesk } from "./universe-desk"
import { usePlotEnsurer } from "./workshop/use-ensure-plot"
import { projectErrorText } from "./project-error"
import { useDatabaseRows } from "./workshop/use-database-rows"
import { OVERVIEW_SECTION, useCreativeNavStore } from "./creative-nav-store"
import { useProjectStore } from "./project-store"
import { groupSections, resolveProjectTarget, type SidebarSection } from "./project-tree-model"
import { sectionRoleIcon } from "./section-icons"

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
}: ProjectPageProps) {
  const { t } = useTranslation()
  const status = useProjectStore((state) => state.status)
  const catalog = useProjectStore((state) => state.catalog)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const selected = useCreativeNavStore((state) => state.sectionByProject[projectId])
  const showSection = useCreativeNavStore((state) => state.showSection)
  const [addingSection, setAddingSection] = React.useState(false)
  const [editingSettings, setEditingSettings] = React.useState(false)
  const [toolbarHost, setToolbarHost] = React.useState<HTMLDivElement | null>(null)
  // The anchors may need a relation to a base that was just made; a failure is shown, not lost.
  const { ensureAnchorLinks } = usePlotEnsurer(onChanged)
  const [linkNotice, setLinkNotice] = React.useState<string | null>(null)

  const target = React.useMemo(() => resolveProjectTarget(catalog, projectId), [catalog, projectId])

  // A universe is named by its card, which is a row of the universes section.
  const dataNonce = useCreativeNavStore((state) => state.dataNonce)
  const universeSection =
    target?.kind === "universe"
      ? target.workshop.sections.find(
          (section) => section.role === "universes" && section.state !== "missing",
        )
      : undefined
  const universeRows = useDatabaseRows(
    universeSection ? [universeSection.databaseId] : [],
    dataNonce,
  )
  const universeTitle =
    target?.kind === "universe" && universeSection
      ? universeRows.rows[universeSection.databaseId]?.find(
          (row) => row.noteId === target.universeId,
        )?.title
      : undefined

  if (!target) {
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

  const { workshop } = target
  const isStory = target.kind === "story"
  const isUniverse = target.kind === "universe"
  const story = target.kind === "story" ? target.story : null

  const pageTitle = isStory
    ? (story?.name ?? "")
    : isUniverse
      ? (universeTitle ?? t("creative.kind.universe"))
      : workshop.name
  const pageIcon = isStory ? null : isUniverse ? null : workshop.icon
  const pageTags: string[] = isStory ? [] : isUniverse ? [] : workshop.tags
  const kindLabel = isStory
    ? t("creative.kind.story")
    : isUniverse
      ? t("creative.kind.universe")
      : t("creative.welcome.title", "Творческая мастерская")

  const groups = groupSections(workshop)
  const sections = groups.flatMap((group) => group.sections)
  const active =
    selected && sections.some((section) => section.id === selected) ? selected : OVERVIEW_SECTION
  const activeSection = sections.find((section) => section.id === active)
  const stories = workshop.stories

  const hasDesk = isStory && Boolean(story?.text?.databaseId) && Boolean(onOpenNote)
  const universeId = target.kind === "universe" ? target.universeId : null
  const hasUniverseDesk = universeId !== null && Boolean(onOpenNote)

  const tabClass = (isActive: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
      isActive
        ? "bg-slate-100 text-slate-900 dark:bg-accent dark:text-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    )

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--note-surface)]">
      <header className="flex shrink-0 flex-col gap-3 px-8 pb-2 pt-6">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">
            <IconValue
              value={pageIcon ?? undefined}
              fallback={isStory ? <BookOpen className="size-7" /> : <Globe2 className="size-7" />}
              className="size-8 rounded-md"
            />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{pageTitle}</h1>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{kindLabel}</span>
              {pageTags.map((tag) => (
                <span key={tag} className="rounded-full bg-accent px-2 py-0.5">
                  {tag}
                </span>
              ))}
            </p>
          </div>
          {!workshop.readOnly && (
            <div className="flex items-center gap-1.5">
              {!isStory && (
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
            </div>
          )}
        </div>
        {workshop.readOnly && (
          <p className="flex items-center gap-2 rounded-md border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            {t("creative.page.readOnlyBanner", { version: workshop.formatVersion })}
          </p>
        )}
        <div className="flex min-w-0 items-center gap-2 pb-1">
          <nav
            aria-label={t("creative.page.sections")}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            <button
              type="button"
              className={tabClass(active === OVERVIEW_SECTION)}
              aria-current={active === OVERVIEW_SECTION ? "page" : undefined}
              onClick={() => showSection(projectId, OVERVIEW_SECTION)}
            >
              {hasDesk
                ? t("creative.page.desk.title", "Рабочий стол")
                : t("creative.page.overview")}
            </button>
            {groups.map((group) => (
              <React.Fragment key={group.id ?? "loose"}>
                {group.name && (
                  <span
                    aria-hidden="true"
                    title={group.name}
                    className="mx-1.5 h-4 w-px shrink-0 self-center bg-border"
                  />
                )}
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
            className="mx-8 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
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
        {activeSection ? (
          activeSection.state === "missing" ? (
            <div className="m-8 flex flex-col gap-1 rounded-xl border border-dashed border-border p-6 text-sm">
              <p className="font-medium">{t("creative.page.sectionMissing")}</p>
              <p className="text-muted-foreground">{t("creative.page.sectionMissingHint")}</p>
            </div>
          ) : (
            <div key={activeSection.databaseId} className="flex min-h-0 flex-1 flex-col">
              {renderDatabase({
                databaseId: activeSection.databaseId,
                title: activeSection.name,
                readOnly: workshop.readOnly,
                toolbarHost,
              })}
            </div>
          )
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-4">
            {hasDesk && onOpenNote && story && (
              <ProjectDesk
                story={story}
                workshop={workshop}
                vaultPath={vaultPath}
                onOpenNote={onOpenNote}
                onOpenSection={(_ownerId, sectionId) => showSection(projectId, sectionId)}
              />
            )}
            {hasUniverseDesk && onOpenNote && universeId && (
              <UniverseDesk
                workshop={workshop}
                universeId={universeId}
                onOpenNote={onOpenNote}
                onOpenStory={(storyId) => onOpenProject(storyId)}
                onOpenSection={(_ownerId, sectionId) => showSection(projectId, sectionId)}
                onEnsureAnchorLinks={ensureAnchorLinks}
              />
            )}
            {!hasDesk && !hasUniverseDesk && stories.length > 0 && (
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold">{t("creative.page.stories")}</h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {stories.map((st) => (
                    <button
                      key={st.storyId}
                      type="button"
                      onClick={() => onOpenProject(st.storyId)}
                      className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/40 hover:bg-accent/30"
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                        <BookOpen className="size-5" />
                      </span>
                      <span className="truncate text-sm font-medium">{st.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {!hasDesk &&
              !hasUniverseDesk &&
              groups.map((group) => (
                <section key={group.id ?? "loose"} className="mb-8">
                  {group.name && <h2 className="mb-3 text-sm font-semibold">{group.name}</h2>}
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
            {!hasDesk && !hasUniverseDesk && sections.length === 0 && stories.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("creative.page.noSections")}</p>
            )}
          </div>
        )}
      </div>

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
