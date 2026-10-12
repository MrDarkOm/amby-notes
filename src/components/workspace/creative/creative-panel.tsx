import * as React from "react"
import { AlertTriangle, Feather, Loader2, Plus, Settings } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import {
  createDatabaseRow,
  type CreatedProject,
  type ProjectDiagnostic,
  type ProjectSummary,
} from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { PanelHeader } from "../panels/panel-header"
import { type ChooserExtra, type CreateChoice, useChooserOptions } from "./chooser-options"
import { CreateChooserDialog } from "./create-chooser-dialog"
import { CreateProjectDialog } from "./create-project-dialog"
import { CreateSectionDialog } from "./create-section-dialog"
import { useCreativeNavStore } from "./creative-nav-store"
import { CreativeScopePicker } from "./creative-scope-picker"
import { readStoredScope, readWorkshopPrefs, writeStoredScope } from "./creative-scope-storage"
import {
  findProject,
  listScopes,
  resolveScope,
  STANDALONE_SCOPE,
  writableCollection,
} from "./project-tree-model"
import type { NewProjectKind } from "./project-labels"
import { useProjectStore } from "./project-store"
import {
  defaultSource,
  isWorksSection,
  entityTabs,
  selectedStoryOf,
  workshopScope,
} from "./workshop/workshop-model"
import { WorkshopPane } from "./workshop/workshop-pane"

interface NewProjectRequest {
  /** The collection the project goes into; none for the vault root. */
  parent: ProjectSummary | null
  kinds?: NewProjectKind[]
  initialKind?: NewProjectKind
}

/**
 * The scope after a project is created: a new collection becomes the scope, a new
 * stand-alone story moves the sidebar to its bucket, and a story inside a collection
 * leaves the scope as it is (`undefined`).
 */
function scopeAfterCreate(created: CreatedProject, parent: ProjectSummary | null) {
  if (created.kind === "collection") return created.projectId
  return parent ? undefined : STANDALONE_SCOPE
}

function DiagnosticsNotice({ diagnostics }: { diagnostics: ProjectDiagnostic[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  if (diagnostics.length === 0) return null
  return (
    <div className="mx-3 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-800 dark:text-amber-200">
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

export function CreativePanel({
  databaseRuntimeEnabled,
  vault,
  onSelect,
  onDelete,
  onDeleteMany,
  onRename,
  onOpenInNewTab,
  onOpenCreativeProject,
  onCreativeChanged,
  onOpenSettings,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const status = useProjectStore((state) => state.status)
  const catalog = useProjectStore((state) => state.catalog)
  const error = useProjectStore((state) => state.error)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const scope = useCreativeNavStore((state) => state.scope)
  const setScope = useCreativeNavStore((state) => state.setScope)
  const rawStoryFilter = useCreativeNavStore((state) => state.storyFilter)
  const worldScope = useCreativeNavStore((state) => state.worldScope)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const createRequest = useCreativeNavStore((state) => state.createRequest)
  const [newProject, setNewProject] = React.useState<NewProjectRequest | null>(null)
  const [chooserOpen, setChooserOpen] = React.useState(false)
  const [sectionRequest, setSectionRequest] = React.useState<{
    project: ProjectSummary
    initial?: { name: string; choice: string }
  } | null>(null)
  const setSectionFor = (project: ProjectSummary | null) =>
    setSectionRequest(project ? { project } : null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  // What was last chosen in this vault: the scope, and what the lists were showing.
  React.useEffect(() => {
    if (!vault) return
    const nav = useCreativeNavStore.getState()
    nav.setScope(readStoredScope(vault))
    const prefs = readWorkshopPrefs(vault)
    nav.setStoryFilter(prefs.story ?? null)
    nav.setWorldScope(prefs.world ?? "story")
    const open = Array.isArray(prefs.works)
      ? prefs.works.filter(isWorksSection)
      : ["books" as const]
    nav.setWorksOpen({
      books: open.includes("books"),
      arcs: open.includes("arcs"),
      anchors: open.includes("anchors"),
      notes: open.includes("notes"),
    })
  }, [vault])

  // "Create a story / a universe" asked for from the empty tab. The panel may only now have
  // mounted, so the request waits in the store until the catalog is here.
  React.useEffect(() => {
    if (!createRequest || !catalog) return
    useCreativeNavStore.getState().clearCreateRequest()
    if (createRequest === "universe") {
      setNewProject({ parent: null, kinds: ["universe"] })
    } else {
      const resolved = resolveScope(catalog, useCreativeNavStore.getState().scope)
      const collection = resolved === null ? null : findProject(catalog, resolved)
      setNewProject({
        parent: writableCollection(collection),
        kinds: ["story"],
        initialKind: "story",
      })
    }
  }, [catalog, createRequest])

  const chooseScope = (next: string | null) => {
    setScope(next)
    if (vault) writeStoredScope(vault, next)
  }

  // A stale scope (a collection that is gone) falls back on every render.
  const resolvedScope = catalog ? resolveScope(catalog, scope) : null
  const scopeProject =
    catalog && resolvedScope !== null ? findProject(catalog, resolvedScope) : null
  const workshop = React.useMemo(
    () => (catalog ? workshopScope(catalog, resolvedScope) : null),
    [catalog, resolvedScope],
  )
  const categories = React.useMemo(() => (workshop ? entityTabs(workshop) : []), [workshop])
  const selectedStory = workshop ? selectedStoryOf(workshop.stories, rawStoryFilter) : null

  const openProject = React.useCallback(
    (projectId: string, sectionId?: string) => {
      onOpenCreativeProject?.(projectId, sectionId)
    },
    [onOpenCreativeProject],
  )
  const openNote = React.useCallback((noteId: string) => onSelect?.(noteId), [onSelect])
  const afterWrite = async (projectId: string, sectionId?: string, nextScope?: string | null) => {
    await onCreativeChanged?.()
    await useProjectStore.getState().refresh?.()
    if (nextScope !== undefined) chooseScope(nextScope)
    openProject(projectId, sectionId)
  }

  // Where a new page of a category goes: the chosen story's own section when the world shows
  // that story, else the shared one, else the first the category has.
  const worldStoryId =
    workshop?.collection === null || worldScope === "story"
      ? (selectedStory?.projectId ?? null)
      : null
  const sourceOf = (categoryKey: string) => {
    const category = categories.find((entry) => entry.key === categoryKey)
    return category && workshop
      ? defaultSource(category, worldStoryId, workshop.collection?.projectId ?? null)
      : null
  }

  const extra: ChooserExtra[] = []
  for (const category of categories) {
    const source = sourceOf(category.key)
    if (!source || source.project.readOnly) continue
    extra.push({
      value: `entity:${category.key}`,
      title: t("creative.workshop.newEntity", { name: category.name }),
      hint: t("creative.workshop.newEntityHint", { where: source.project.name }),
    })
  }
  if (selectedStory && !selectedStory.readOnly && selectedStory.text?.databaseId) {
    extra.unshift({
      value: "page",
      title: t("creative.workshop.page.title"),
      hint: t("creative.workshop.newPageHint", { name: selectedStory.name }),
    })
  }

  if (selectedStory && !selectedStory.readOnly) {
    extra.push({
      value: `section:${selectedStory.projectId}`,
      title: t("creative.chooser.sectionInStory", { name: selectedStory.name }),
      hint: t("creative.chooser.sectionInStoryHint"),
    })
  }
  const chooserOptions = useChooserOptions(scopeProject, extra)

  const createEntity = async (categoryKey: string) => {
    const source = sourceOf(categoryKey)
    if (!source || vaultGeneration === null) return
    setActionError(null)
    try {
      const created = await createDatabaseRow({
        expectedGeneration: vaultGeneration,
        databaseId: source.section.databaseId,
        title: t("creative.workshop.untitled"),
        template: { kind: "default" },
      })
      bumpData()
      openNote(created.noteId)
    } catch (caught) {
      bumpData()
      setActionError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  // The bottom button offers what fits: a page of the chosen story or of a world category, a
  // story (inside a collection when the scope is a writable one), a section of that collection,
  // a universe or a collection.
  const pickCreate = (choice: CreateChoice) => {
    setChooserOpen(false)
    const collection = writableCollection(scopeProject)
    if (choice.startsWith("entity:")) {
      void createEntity(choice.slice("entity:".length))
    } else if (choice === "page") {
      useCreativeNavStore.getState().requestPage(selectedStory?.projectId ?? null)
    } else if (choice.startsWith("section:")) {
      const id = choice.slice("section:".length)
      const target = workshop?.stories.find((story) => story.projectId === id)
      if (target) setSectionFor(target)
    } else if (choice === "section") {
      if (collection) setSectionFor(collection)
    } else if (choice === "story") {
      setNewProject({ parent: collection, kinds: ["story"], initialKind: "story" })
    } else if (choice === "universe" || choice === "collection") {
      setNewProject({ parent: null, kinds: [choice] })
    }
  }

  const header = (
    <PanelHeader
      title={t("panels.creative")}
      actions={
        onOpenSettings ? (
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("activityBar.creativeSettings")}
            aria-label={t("activityBar.creativeSettings")}
            onClick={() => onOpenSettings({ section: "modules", moduleId: "creative" })}
          >
            <Settings className="size-4" />
          </Button>
        ) : undefined
      }
    />
  )

  const hasProjects = Boolean(catalog && catalog.projects.length > 0)
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
  } else if (!hasProjects) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
        <Feather className="size-7 text-muted-foreground" />
        <p className="text-xs font-medium">{t("creative.panel.empty")}</p>
        <p className="text-[11px] text-muted-foreground">{t("creative.panel.emptyHint")}</p>
        <Button size="sm" onClick={() => setChooserOpen(true)}>
          {t("creative.panel.newProject")}
        </Button>
      </div>
    )
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <DiagnosticsNotice diagnostics={catalog.diagnostics} />
        {actionError && (
          <p role="alert" className="mx-3 mb-2 break-words text-[11px] text-destructive">
            {actionError}
          </p>
        )}
        <WorkshopPane
          catalog={catalog}
          scopeId={resolvedScope}
          vault={vault ?? null}
          vaultGeneration={vaultGeneration}
          onOpenNote={openNote}
          onOpenProject={openProject}
          onAddSection={(project, options) => setSectionRequest({ project, initial: options })}
          onAddEntity={(key) => void createEntity(key)}
          itemActions={{
            onOpenInNewTab,
            onRename,
            onDelete: onDelete ? (id) => onDelete(id) : undefined,
            onDeleteMany,
          }}
          createOptions={chooserOptions}
          onCreate={pickCreate}
        />
      </div>
    )
  }

  const bottom =
    databaseRuntimeEnabled && catalog && status !== "disabled" ? (
      <div className="shrink-0 p-2">
        <Button
          className="w-full gap-2 border border-foreground/10 bg-foreground/10 font-medium text-foreground shadow-sm hover:bg-foreground/15 hover:shadow-md active:shadow-sm focus-visible:ring-1 focus-visible:ring-foreground/20"
          whileTap={{ y: 1, scale: 0.99 }}
          onClick={() => setChooserOpen(true)}
        >
          <Plus className="size-4" />
          {t("creative.panel.create")}
        </Button>
        <div className="mt-2">
          <CreativeScopePicker
            scopes={listScopes(catalog)}
            current={resolvedScope}
            onSelect={chooseScope}
          />
        </div>
      </div>
    ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {header}
      {body}
      {bottom}
      <CreateChooserDialog
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        options={chooserOptions}
        onPick={pickCreate}
      />
      <CreateProjectDialog
        open={newProject !== null}
        onClose={() => setNewProject(null)}
        vaultGeneration={vaultGeneration}
        parent={newProject?.parent ?? null}
        kinds={newProject?.kinds}
        initialKind={newProject?.initialKind}
        onCreated={(created) =>
          void afterWrite(
            created.projectId,
            undefined,
            scopeAfterCreate(created, newProject?.parent ?? null),
          )
        }
      />
      {sectionRequest && (
        <CreateSectionDialog
          open
          onClose={() => setSectionRequest(null)}
          vaultGeneration={vaultGeneration}
          project={sectionRequest.project}
          initial={sectionRequest.initial}
          onCreated={(created) => void afterWrite(created.projectId, created.section.sectionId)}
        />
      )}
    </div>
  )
}
