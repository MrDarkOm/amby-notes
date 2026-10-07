import * as React from "react"
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Feather,
  Globe2,
  Layers,
  Loader2,
  Lock,
  Plus,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import { cn } from "@/lib/utils"
import type { ProjectDiagnostic, ProjectSummary } from "@/lib/storage"
import { IconValue } from "../icon-value"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { PanelHeader } from "../panels/panel-header"
import { CreateProjectDialog } from "./create-project-dialog"
import { CreateSectionDialog } from "./create-section-dialog"
import { useCreativeNavStore } from "./creative-nav-store"
import {
  buildProjectTree,
  type SidebarGroup,
  type SidebarProject,
  type SidebarSection,
} from "./project-tree-model"
import { useProjectStore } from "./project-store"
import { sectionRoleIcon } from "./section-icons"

function projectFallbackIcon(project: ProjectSummary) {
  if (project.kind === "story") return <BookOpen className="size-4" />
  // A collection with its own world sections is a universe.
  return project.sections.length > 0 ? <Globe2 className="size-4" /> : <Layers className="size-4" />
}

function DiagnosticsNotice({ diagnostics }: { diagnostics: ProjectDiagnostic[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  if (diagnostics.length === 0) return null
  return (
    <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-800 dark:text-amber-200">
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{t("creative.panel.diagnostics", { count: diagnostics.length })}</span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 pl-5">
          {diagnostics.map((entry, index) => (
            <li key={`${entry.code}:${entry.path}:${index}`} className="break-words">
              {t(`creative.diagnostic.${entry.code}`, { defaultValue: entry.code })}
              <span className="block text-muted-foreground">{entry.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface RowHandlers {
  onOpenProject: (projectId: string, sectionId?: string) => void
  onAddSection: (project: ProjectSummary) => void
  onAddStory: (collection: ProjectSummary) => void
}

function SectionRow({
  section,
  onOpen,
}: {
  section: SidebarSection
  onOpen: (section: SidebarSection) => void
}) {
  const { t } = useTranslation()
  const Icon = sectionRoleIcon(section.role)
  const missing = section.state === "missing"
  return (
    <button
      type="button"
      onClick={() => onOpen(section)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/50",
        missing && "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{section.name}</span>
      {missing && (
        <span title={t("creative.panel.sectionMissing")}>
          <AlertTriangle
            className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500"
            aria-label={t("creative.panel.sectionMissing")}
          />
        </span>
      )}
    </button>
  )
}

function GroupBlock({
  group,
  onOpen,
}: {
  group: SidebarGroup
  onOpen: (section: SidebarSection) => void
}) {
  return (
    <div className="mt-1">
      {group.name && (
        <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {group.name}
        </div>
      )}
      {group.sections.map((section) => (
        <SectionRow key={section.id} section={section} onOpen={onOpen} />
      ))}
    </div>
  )
}

function ProjectNode({
  node,
  depth,
  handlers,
}: {
  node: SidebarProject
  depth: number
  handlers: RowHandlers
}) {
  const { t } = useTranslation()
  const { project } = node
  const collapsed = useCreativeNavStore((state) => state.collapsed[project.projectId] ?? false)
  const toggle = useCreativeNavStore((state) => state.toggleCollapsed)
  const hasChildren = node.groups.length > 0 || node.stories.length > 0 || !project.readOnly
  const isCollection = project.kind === "collection"
  const open = hasChildren && !collapsed
  return (
    <div className={cn(depth > 0 && "ml-3 border-l border-border/60 pl-1")}>
      <div className="group flex items-center gap-1 rounded-md hover:bg-accent/40">
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0"
          disabled={!hasChildren}
          aria-label={open ? t("creative.panel.collapse") : t("creative.panel.expand")}
          aria-expanded={open}
          onClick={() => toggle(project.projectId)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs font-medium"
          onClick={() => handlers.onOpenProject(project.projectId)}
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <IconValue
              value={project.icon ?? undefined}
              fallback={projectFallbackIcon(project)}
              className="size-4"
            />
          </span>
          <span className="min-w-0 truncate">{project.name}</span>
          {project.readOnly && (
            <span title={t("creative.panel.readOnly")}>
              <Lock
                className="size-3 shrink-0 text-muted-foreground"
                aria-label={t("creative.panel.readOnly")}
              />
            </span>
          )}
        </button>
        {!project.readOnly && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            title={isCollection ? t("creative.panel.newStory") : t("creative.panel.newSection")}
            aria-label={
              isCollection ? t("creative.panel.newStory") : t("creative.panel.newSection")
            }
            onClick={() =>
              isCollection ? handlers.onAddStory(project) : handlers.onAddSection(project)
            }
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      {open && (
        <div className="pb-1 pl-5">
          {node.stories.map((story) => (
            <ProjectNode
              key={story.project.projectId}
              node={story}
              depth={depth + 1}
              handlers={handlers}
            />
          ))}
          {node.groups.map((group) => (
            <GroupBlock
              key={group.id ?? "loose"}
              group={group}
              onOpen={(section) => handlers.onOpenProject(project.projectId, section.id)}
            />
          ))}
          {!project.readOnly && (
            <button
              type="button"
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40"
              onClick={() => handlers.onAddSection(project)}
            >
              <Plus className="size-3.5" />
              {t("creative.panel.newSection")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function CreativePanel({
  databaseRuntimeEnabled,
  onOpenCreativeProject,
  onCreativeChanged,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const status = useProjectStore((state) => state.status)
  const catalog = useProjectStore((state) => state.catalog)
  const error = useProjectStore((state) => state.error)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const [newProjectParent, setNewProjectParent] = React.useState<ProjectSummary | null | undefined>(
    undefined,
  )
  const [sectionFor, setSectionFor] = React.useState<ProjectSummary | null>(null)
  const tree = React.useMemo(() => (catalog ? buildProjectTree(catalog) : []), [catalog])

  const open = React.useCallback(
    (projectId: string, sectionId?: string) => {
      onOpenCreativeProject?.(projectId, sectionId)
    },
    [onOpenCreativeProject],
  )
  const afterWrite = async (projectId: string, sectionId?: string) => {
    await onCreativeChanged?.()
    await useProjectStore.getState().refresh?.()
    open(projectId, sectionId)
  }
  const handlers: RowHandlers = {
    onOpenProject: open,
    onAddSection: setSectionFor,
    onAddStory: setNewProjectParent,
  }

  const header = (
    <PanelHeader
      title={t("panels.creative")}
      actions={
        databaseRuntimeEnabled ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("creative.panel.newProject")}
            aria-label={t("creative.panel.newProject")}
            onClick={() => setNewProjectParent(null)}
          >
            <Plus className="size-4" />
          </Button>
        ) : undefined
      }
    />
  )

  let body: React.ReactNode
  if (!databaseRuntimeEnabled || status === "disabled") {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
        <Feather className="size-7 text-muted-foreground" />
        <p className="text-xs font-medium">{t("creative.panel.disabledTitle")}</p>
        <p className="text-[11px] text-muted-foreground">{t("creative.panel.disabledHint")}</p>
      </div>
    )
  } else if (status === "error" && !catalog) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
        <AlertTriangle className="size-7 text-amber-600 dark:text-amber-500" />
        <p className="text-xs font-medium">{t("creative.panel.loadFailed")}</p>
        <p className="break-words text-[11px] text-muted-foreground">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void useProjectStore.getState().refresh?.(true)}
        >
          {t("creative.panel.retry")}
        </Button>
      </div>
    )
  } else if (!catalog) {
    body = (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <MotionSpinner>
          <Loader2 className="size-4" />
        </MotionSpinner>
      </div>
    )
  } else if (tree.length === 0) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
        <Feather className="size-7 text-muted-foreground" />
        <p className="text-xs font-medium">{t("creative.panel.empty")}</p>
        <p className="text-[11px] text-muted-foreground">{t("creative.panel.emptyHint")}</p>
        <Button size="sm" onClick={() => setNewProjectParent(null)}>
          {t("creative.panel.newProject")}
        </Button>
      </div>
    )
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <DiagnosticsNotice diagnostics={catalog.diagnostics} />
        {tree.map((node) => (
          <ProjectNode key={node.project.projectId} node={node} depth={0} handlers={handlers} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {header}
      {body}
      <CreateProjectDialog
        open={newProjectParent !== undefined}
        onClose={() => setNewProjectParent(undefined)}
        vaultGeneration={vaultGeneration}
        parent={newProjectParent ?? null}
        onCreated={(created) => void afterWrite(created.projectId)}
      />
      {sectionFor && (
        <CreateSectionDialog
          open
          onClose={() => setSectionFor(null)}
          vaultGeneration={vaultGeneration}
          project={sectionFor}
          onCreated={(created) => void afterWrite(created.projectId, created.section.sectionId)}
        />
      )}
    </div>
  )
}
