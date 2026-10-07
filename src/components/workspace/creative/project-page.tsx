import * as React from "react"
import { AlertTriangle, BookOpen, Feather, Globe2, Layers, Lock, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ProjectSummary } from "@/lib/storage"
import { IconValue } from "../icon-value"
import { useDatabaseStore } from "../database/database-store"
import { CreateSectionDialog } from "./create-section-dialog"
import { OVERVIEW_SECTION, useCreativeNavStore } from "./creative-nav-store"
import { useProjectStore } from "./project-store"
import { groupSections, storiesOfCollection, type SidebarSection } from "./project-tree-model"
import { sectionRoleIcon } from "./section-icons"

export interface SectionDatabaseProps {
  databaseId: string
  title: string
}

interface ProjectPageProps {
  projectId: string
  /** Renders one section as the ordinary database workspace (supplied by the shell). */
  renderDatabase: (database: SectionDatabaseProps) => React.ReactNode
  onOpenProject: (projectId: string, sectionId?: string) => void
  /** Refreshes the file tree and the databases after a section was written. */
  onChanged?: () => Promise<void>
}

function kindLabelKey(project: ProjectSummary): string {
  if (project.kind === "story") return "creative.kind.story"
  return project.sections.length > 0 ? "creative.kind.universe" : "creative.kind.collection"
}

function KindIcon({ project, className }: { project: ProjectSummary; className?: string }) {
  if (project.kind === "story") return <BookOpen className={className} />
  return project.sections.length > 0 ? (
    <Globe2 className={className} />
  ) : (
    <Layers className={className} />
  )
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
  // The role is only worth saying when the author named the database something else.
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
  onChanged,
}: ProjectPageProps) {
  const { t } = useTranslation()
  const status = useProjectStore((state) => state.status)
  const catalog = useProjectStore((state) => state.catalog)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const selected = useCreativeNavStore((state) => state.sectionByProject[projectId])
  const showSection = useCreativeNavStore((state) => state.showSection)
  const [addingSection, setAddingSection] = React.useState(false)
  const project = catalog?.projects.find((candidate) => candidate.projectId === projectId) ?? null

  if (!project) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-8">
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

  const groups = groupSections(project)
  const sections = groups.flatMap((group) => group.sections)
  const active =
    selected && sections.some((section) => section.id === selected) ? selected : OVERVIEW_SECTION
  const activeSection = sections.find((section) => section.id === active)
  const stories =
    project.kind === "collection" && catalog ? storiesOfCollection(catalog, project.projectId) : []

  const tabClass = (isActive: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
      isActive
        ? "bg-slate-100 text-slate-900 dark:bg-accent dark:text-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    )

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="flex shrink-0 flex-col gap-3 px-8 pb-2 pt-6">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">
            <IconValue
              value={project.icon ?? undefined}
              fallback={<KindIcon project={project} className="size-7" />}
              className="size-8 rounded-md"
            />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{t(kindLabelKey(project))}</span>
              {project.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-accent px-2 py-0.5">
                  {tag}
                </span>
              ))}
            </p>
          </div>
          {!project.readOnly && (
            <Button variant="outline" size="sm" onClick={() => setAddingSection(true)}>
              <Plus className="size-3.5" />
              {t("creative.panel.newSection")}
            </Button>
          )}
        </div>
        {project.readOnly && (
          <p className="flex items-center gap-2 rounded-md border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            {t("creative.page.readOnlyBanner", { version: project.formatVersion })}
          </p>
        )}
        <nav
          aria-label={t("creative.page.sections")}
          className="flex min-w-0 items-center gap-1 overflow-x-auto pb-1"
        >
          <button
            type="button"
            className={tabClass(active === OVERVIEW_SECTION)}
            aria-current={active === OVERVIEW_SECTION ? "page" : undefined}
            onClick={() => showSection(projectId, OVERVIEW_SECTION)}
          >
            {t("creative.page.overview")}
          </button>
          {groups.map((group) => (
            <React.Fragment key={group.id ?? "loose"}>
              {group.name && (
                <span className="mx-1 shrink-0 self-center text-[10px] uppercase tracking-wide text-muted-foreground">
                  {group.name}
                </span>
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
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeSection ? (
          activeSection.state === "missing" ? (
            <div className="m-8 flex flex-col gap-1 rounded-xl border border-dashed border-border p-6 text-sm">
              <p className="font-medium">{t("creative.page.sectionMissing")}</p>
              <p className="text-muted-foreground">{t("creative.page.sectionMissingHint")}</p>
            </div>
          ) : (
            <div key={activeSection.databaseId} className="flex min-h-0 flex-1 flex-col">
              {renderDatabase({ databaseId: activeSection.databaseId, title: activeSection.name })}
            </div>
          )
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-4">
            {stories.length > 0 && (
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold">{t("creative.page.stories")}</h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {stories.map((story) => (
                    <button
                      key={story.projectId}
                      type="button"
                      onClick={() => onOpenProject(story.projectId)}
                      className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:border-primary/40 hover:bg-accent/30"
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                        <IconValue
                          value={story.icon ?? undefined}
                          fallback={<BookOpen className="size-5" />}
                          className="size-5"
                        />
                      </span>
                      <span className="truncate text-sm font-medium">{story.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {groups.map((group) => (
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
            {sections.length === 0 && stories.length === 0 && (
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
          project={project}
          onCreated={(created) => {
            void (async () => {
              await onChanged?.()
              await useProjectStore.getState().refresh?.()
              showSection(projectId, created.section.sectionId)
            })()
          }}
        />
      )}
    </div>
  )
}
