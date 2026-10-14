import * as React from "react"
import { AlertTriangle, Feather, Loader2, Plus, Settings } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import {
  addStoryLinks,
  createWorkshopEntity,
  type ProjectDiagnostic,
  type WorkshopSummary,
} from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { PanelHeader } from "../panels/panel-header"
import { type ChooserExtra, type CreateChoice, useChooserOptions } from "./chooser-options"
import { CreateChooserDialog } from "./create-chooser-dialog"
import {
  CreateProjectDialog,
  type CreatedItemResult,
  type CreativeCreationKind,
} from "./create-project-dialog"
import { CreateSectionDialog } from "./create-section-dialog"
import { useCreativeNavStore } from "./creative-nav-store"
import { CreativeScopePicker } from "./creative-scope-picker"
import { readStoredScope, readWorkshopPrefs, writeStoredScope } from "./creative-scope-storage"
import { linkLabels } from "./project-labels"
import { projectErrorText } from "./project-error"
import { listScopes, resolveScope } from "./project-tree-model"
import { useProjectStore } from "./project-store"
import { sectionRoleIcon } from "./section-icons"
import {
  entityTabs,
  selectedStoryOf,
  storySection,
  workshopScope,
  worksSectionsFromPrefs,
} from "./workshop/workshop-model"
import { usePlotEnsurer } from "./workshop/use-ensure-plot"
import { WorkshopPane } from "./workshop/workshop-pane"

interface NewProjectRequest {
  workshop: WorkshopSummary | null
  kind?: CreativeCreationKind
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
  selectedId,
  onSelect,
  onDelete,
  onDeleteMany,
  onRename,
  onMoveItem,
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
  const universeFilter = useCreativeNavStore((state) => state.universeFilter)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const createRequest = useCreativeNavStore((state) => state.createRequest)
  const [newProject, setNewProject] = React.useState<NewProjectRequest | null>(null)
  const [chooserOpen, setChooserOpen] = React.useState(false)
  const [sectionRequest, setSectionRequest] = React.useState<{
    workshop: WorkshopSummary
    initial?: { name: string; choice: string }
  } | null>(null)
  const setSectionFor = (ws: WorkshopSummary | null) =>
    setSectionRequest(ws ? { workshop: ws } : null)

  // What was last chosen in this vault: the scope, and what the lists were showing.
  React.useEffect(() => {
    if (!vault) return
    const nav = useCreativeNavStore.getState()
    nav.setScope(readStoredScope(vault))
    const prefs = readWorkshopPrefs(vault)
    nav.setStoryFilter(prefs.story ?? null)
    const open = worksSectionsFromPrefs(prefs.works)
    nav.setWorksOpen({
      text: open.includes("text"),
      anchors: open.includes("anchors"),
      notes: open.includes("notes"),
    })
  }, [vault])

  const chooseScope = (next: string | null) => {
    setScope(next)
    if (vault) writeStoredScope(vault, next)
  }

  // A stale scope falls back on every render.
  const resolvedScope = catalog ? resolveScope(catalog, scope) : null
  const workshopScopeResult = React.useMemo(
    () => (catalog ? workshopScope(catalog, resolvedScope) : null),
    [catalog, resolvedScope],
  )
  const workshop = workshopScopeResult?.workshop ?? null
  const categories = React.useMemo(() => (workshop ? entityTabs(workshop) : []), [workshop])
  // A universe, or the whole workshop, has no story of its own to add a page to.
  const selectedStory =
    rawStoryFilter === "all" || universeFilter !== null
      ? null
      : workshop
        ? selectedStoryOf(workshop.stories, rawStoryFilter)
        : null

  // "Create a story / a universe" asked for from the empty tab.
  React.useEffect(() => {
    if (!createRequest || !catalog) return
    useCreativeNavStore.getState().clearCreateRequest()
    if (createRequest === "universe") {
      setNewProject({ workshop, kind: "universe" })
    } else {
      setNewProject({ workshop, kind: "story" })
    }
  }, [catalog, createRequest, workshop])

  // The operation that makes the missing link properties of anchors and arcs; the first binding
  // needs them, and so does an anchor made as an event of a universe.
  const { ensure: ensurePlot, ensureAnchorLinks } = usePlotEnsurer(onCreativeChanged)

  const openProject = React.useCallback(
    (projectId: string, sectionId?: string) => {
      onOpenCreativeProject?.(projectId, sectionId)
    },
    [onOpenCreativeProject],
  )
  const openNote = React.useCallback((noteId: string) => onSelect?.(noteId), [onSelect])
  // The failure of the anchors' links after a base was made: shown, never swallowed.
  const [linkNotice, setLinkNotice] = React.useState<string | null>(null)
  const afterWrite = async (
    projectId: string,
    sectionId?: string,
    nextScope?: string | null,
    /** The workshop whose anchors may need a relation to the base that was just made. */
    anchorsOf?: string,
  ) => {
    await onCreativeChanged?.()
    await useProjectStore.getState().refresh?.()
    if (anchorsOf) {
      try {
        await ensureAnchorLinks(anchorsOf)
      } catch (caught) {
        setLinkNotice(t("creative.plot.linksFailed", { message: projectErrorText(t, caught) }))
      }
    }
    if (nextScope !== undefined) chooseScope(nextScope)
    openProject(projectId, sectionId)
  }

  const extra: ChooserExtra[] = []
  for (const category of categories) {
    if (!workshop || workshop.readOnly) continue
    extra.push({
      value: `entity:${category.key}`,
      title: t("creative.workshop.newEntity", { name: category.name }),
      hint: t("creative.workshop.newEntityHint", { where: workshop.name }),
      icon: sectionRoleIcon(category.role),
    })
  }
  if (selectedStory && selectedStory.text?.databaseId && !workshop?.readOnly) {
    extra.unshift({
      value: "page",
      title: t("creative.workshop.page.title"),
      hint: t("creative.workshop.newPageHint", { name: selectedStory.name }),
    })
  }

  const chooserOptions = useChooserOptions(workshop, extra)

  /**
   * Creates a world page under the name the author typed in its row. With a story it is born
   * linked to it: the relation is written together with the note, not set afterwards.
   */
  const createEntity = async (
    categoryKey: string,
    title: string,
    storyId: string | null,
    notebook?: string[],
    universeId?: string | null,
  ) => {
    // The notes and anchors bases are not world categories, but their pages are made the same way;
    // a note's notebook is a folder of the base.
    const sectionId =
      categoryKey === "notes" || categoryKey === "anchors"
        ? storySection(workshop, categoryKey)?.id
        : categories.find((t) => t.key === categoryKey)?.sectionId
    if (!sectionId || !workshop || vaultGeneration === null) return
    try {
      // An event of a universe needs the anchors' "Universe" relation: made first, and a failure
      // stops here, on the row that asked for it.
      if (universeId) await ensureAnchorLinks(workshop.workshopId)
      const created = await createWorkshopEntity({
        expectedGeneration: vaultGeneration,
        workshopId: workshop.workshopId,
        sectionId,
        title,
        storyId,
        notebook: notebook && notebook.length > 0 ? notebook : null,
        universeId: universeId ?? null,
      })
      bumpData()
      openNote(created.noteId)
    } catch (caught) {
      bumpData()
      throw caught
    }
  }

  // One operation ID per link intent, so a retry of the same request is answered from the record.
  const linkOperations = React.useRef(new Map<string, string>())
  /** Links a section of an older workshop and reads the catalog again; rejects on failure. */
  const linkSection = async (target: WorkshopSummary, sectionId: string) => {
    if (vaultGeneration === null) return
    const key = `${target.workshopId}:${target.fileRevision}:${sectionId}`
    let operationId = linkOperations.current.get(key)
    if (!operationId) {
      operationId = `links-${crypto.randomUUID()}`
      linkOperations.current.set(key, operationId)
    }
    await addStoryLinks({
      expectedGeneration: vaultGeneration,
      operationId,
      workshopId: target.workshopId,
      expectedWorkshopRevision: target.fileRevision,
      sectionId,
      labels: linkLabels(t),
    })
    await onCreativeChanged?.()
    await useProjectStore.getState().refresh?.()
  }

  const pickCreate = (choice: CreateChoice) => {
    setChooserOpen(false)
    if (choice.startsWith("entity:")) {
      useCreativeNavStore.getState().requestEntity(choice.slice("entity:".length))
    } else if (choice === "page") {
      useCreativeNavStore.getState().requestPage(selectedStory?.storyId ?? null)
    } else if (choice === "section") {
      if (workshop) setSectionFor(workshop)
    } else if (choice === "story") {
      setNewProject({ workshop, kind: "story" })
    } else if (choice === "universe") {
      setNewProject({ workshop, kind: "universe" })
    } else if (choice === "workshop") {
      setNewProject({ workshop: null, kind: "workshop" })
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

  const hasWorkshops = Boolean(catalog && catalog.workshops.length > 0)
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
  } else if (!hasWorkshops) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
        <Feather className="size-7 text-muted-foreground" />
        <p className="text-xs font-medium">{t("creative.panel.empty")}</p>
        <p className="text-[11px] text-muted-foreground">{t("creative.panel.emptyHint")}</p>
        <Button size="sm" onClick={() => setNewProject({ workshop: null, kind: "workshop" })}>
          {t("creative.panel.newProject")}
        </Button>
      </div>
    )
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <DiagnosticsNotice diagnostics={catalog.diagnostics} />
        {linkNotice && (
          <div
            role="alert"
            className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive"
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
        <WorkshopPane
          catalog={catalog}
          scopeId={resolvedScope}
          vault={vault ?? null}
          vaultGeneration={vaultGeneration}
          onOpenNote={openNote}
          activeNoteId={selectedId}
          onOpenProject={openProject}
          onAddSection={(ws, options) => setSectionRequest({ workshop: ws, initial: options })}
          onCreateEntity={createEntity}
          onLinkSection={linkSection}
          onEnsurePlot={ensurePlot}
          itemActions={{
            onOpenInNewTab,
            onRename,
            onDelete: onDelete ? (id) => onDelete(id) : undefined,
            onDeleteMany,
          }}
          fileActions={{ onMoveItem, onCreativeChanged }}
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
        workshop={newProject?.workshop ?? workshop}
        initialKind={newProject?.kind}
        onCreated={(created: CreatedItemResult) =>
          void afterWrite(
            created.id,
            undefined,
            created.kind === "workshop" ? created.id : undefined,
            created.kind === "universe"
              ? (newProject?.workshop ?? workshop)?.workshopId
              : undefined,
          )
        }
      />
      {sectionRequest && (
        <CreateSectionDialog
          open
          onClose={() => setSectionRequest(null)}
          vaultGeneration={vaultGeneration}
          workshop={sectionRequest.workshop}
          initial={sectionRequest.initial}
          onCreated={(created) =>
            void afterWrite(
              sectionRequest.workshop.workshopId,
              created.section.sectionId,
              undefined,
              sectionRequest.workshop.workshopId,
            )
          }
        />
      )}
    </div>
  )
}
