import * as React from "react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Feather,
  Loader2,
  Plus,
  Settings,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"
import { createWorkshopEntity, type ProjectDiagnostic, type WorkshopSummary } from "@/lib/storage"
import type { PanelRenderProps } from "../panel-registry"
import { useDatabaseStore } from "../database/database-store"
import { PanelHeader } from "../panels/panel-header"
import { type ChooserExtra, type CreateChoice, useChooserOptions } from "./chooser-options"
import { CompleteWorkshopNotice } from "./complete-workshop-notice"
import { CreateChooserDialog } from "./create-chooser-dialog"
import {
  CreateProjectDialog,
  type CreatedItemResult,
  type CreativeCreationKind,
} from "./create-project-dialog"
import { CreateSectionDialog } from "./create-section-dialog"
import { useCreativeNavStore } from "./creative-nav-store"
import { useCreativeSettingsStore } from "./creative-settings-store"
import { readWorkshopPrefs, writeWorkshopPrefs, type WorkshopPrefs } from "./creative-scope-storage"
import { projectErrorText } from "./project-error"
import { useProjectStore } from "./project-store"
import { standaloneTargetId, universeTargetId } from "./project-tree-model"
import { sectionRoleIcon } from "./section-icons"
import { useCompleteWorkshop } from "./use-complete-workshop"
import { useStoryLinks } from "./use-story-links"
import { hasGaps, workshopGaps } from "./workshop-gaps"
import { WorkshopInitScreen } from "./workshop-init-screen"
import { resolveWorkshopPlace } from "./workshop-location"
import { entityTabs, storySection, worksSectionsFromPrefs } from "./workshop/workshop-model"
import { UniverseCard } from "./workshop/universe-card"
import { usePlotEnsurer } from "./workshop/use-ensure-plot"
import { useUniverses } from "./workshop/use-universes"
import { WorkshopPane } from "./workshop/workshop-pane"

/** What the card of the universes stores for the stories that no universe holds. */
const STANDALONE = "standalone"

interface NewProjectRequest {
  workshop: WorkshopSummary | null
  kind?: CreativeCreationKind
  /** What the dialog offers; the card of the universes offers only a universe. */
  kinds?: CreativeCreationKind[]
}

function DiagnosticsNotice({ diagnostics }: { diagnostics: ProjectDiagnostic[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  if (diagnostics.length === 0) return null
  return (
    <div className="mx-3 mb-2 min-w-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-800 dark:text-amber-200">
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
              <span className="block break-all text-muted-foreground">{entry.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Folders of the former format (`amby-project.json`) are not damage: they open as ordinary folders.
 * One quiet, folded line at the foot of the panel lists them; the banner is for what needs a look.
 */
function LegacyFoldersRow({ diagnostics }: { diagnostics: ProjectDiagnostic[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  if (diagnostics.length === 0) return null
  return (
    <div className="shrink-0 border-t border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 text-left hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <span className="min-w-0 break-words">
          {t("creative.panel.legacyFolders", { count: diagnostics.length })}
        </span>
      </button>
      {open && (
        <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto overflow-x-hidden pl-4">
          {diagnostics.map((entry, index) => (
            <li key={`${entry.path}:${index}`} className="break-all">
              {entry.path}
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
  const rawCatalog = useProjectStore((state) => state.rawCatalog)
  const workshopSetting = useCreativeSettingsStore((state) => state.workshopPath)
  const universeFilter = useCreativeNavStore((state) => state.universeFilter)
  const bumpData = useCreativeNavStore((state) => state.bumpData)
  const createRequest = useCreativeNavStore((state) => state.createRequest)
  const [newProject, setNewProject] = React.useState<NewProjectRequest | null>(null)
  const [chooserOpen, setChooserOpen] = React.useState(false)
  const [sectionRequest, setSectionRequest] = React.useState<{
    workshop: WorkshopSummary
  } | null>(null)
  const setSectionFor = (ws: WorkshopSummary | null) =>
    setSectionRequest(ws ? { workshop: ws } : null)

  // What was last chosen in this vault: what the lists were showing.
  React.useEffect(() => {
    if (!vault) return
    const nav = useCreativeNavStore.getState()
    const prefs = readWorkshopPrefs(vault)
    nav.setStoryFilter(prefs.story ?? null)
    nav.setUniverseFilter(prefs.universe && prefs.universe !== STANDALONE ? prefs.universe : null)
    const open = worksSectionsFromPrefs(prefs.works)
    nav.setWorksOpen({
      text: open.includes("text"),
      anchors: open.includes("anchors"),
      notes: open.includes("notes"),
    })
  }, [vault])

  // The catalog already holds only the workshop the setting names (or the one found).
  const workshop = catalog?.workshops[0] ?? null
  const place = React.useMemo(
    () =>
      resolveWorkshopPlace(
        rawCatalog?.workshops ?? [],
        workshopSetting,
        t("creative.workshop.defaultFolder"),
      ),
    [rawCatalog, t, workshopSetting],
  )
  const categories = React.useMemo(() => (workshop ? entityTabs(workshop) : []), [workshop])
  // A page is added to the story the lists show now; a universe or the standalone stories as a
  // whole have no story of their own.
  const shownStoryId = useCreativeNavStore((state) => state.shownStoryId)
  const selectedStory = workshop?.stories.find((story) => story.storyId === shownStoryId) ?? null
  // The universes of the workshop: the card below and the lists above read the same rows.
  const { universes, known: universesKnown } = useUniverses(workshop)
  // The universe chosen stands until the list is read and shows it gone.
  const activeUniverseId =
    universeFilter !== null &&
    (!universesKnown || universes.some((universe) => universe.noteId === universeFilter))
      ? universeFilter
      : null
  // A universe made a moment ago is chosen before the list has read it: it is not "missing".
  const justCreatedUniverse = React.useRef<string | null>(null)
  const remember = React.useCallback(
    (patch: WorkshopPrefs) => {
      if (vault) writeWorkshopPrefs(vault, patch)
    },
    [vault],
  )
  // A remembered universe that is gone (deleted, or the base is) is dropped, not kept as a ghost.
  React.useEffect(() => {
    if (universeFilter === null || !universesKnown) return
    if (universes.some((universe) => universe.noteId === universeFilter)) {
      if (justCreatedUniverse.current === universeFilter) justCreatedUniverse.current = null
      return
    }
    if (justCreatedUniverse.current === universeFilter) return
    useCreativeNavStore.getState().setUniverseFilter(null)
    remember({ universe: STANDALONE })
  }, [remember, universeFilter, universes, universesKnown])

  /** Sets the scope: a universe, or `null` for the standalone stories. */
  const chooseUniverse = (universeId: string | null) => {
    const nav = useCreativeNavStore.getState()
    nav.setUniverseFilter(universeId)
    const patch: WorkshopPrefs = { universe: universeId ?? STANDALONE }
    // "No story chosen yet" meant the first story of the scope: choosing a scope shows it whole.
    if (nav.storyFilter === null) {
      nav.setStoryFilter("all")
      patch.story = "all"
    }
    remember(patch)
  }

  // "Create a story / a universe" asked for from the empty tab.
  React.useEffect(() => {
    if (!createRequest || !catalog) return
    useCreativeNavStore.getState().clearCreateRequest()
    // Without a workshop there is nothing to make a story in: the panel offers to initialize.
    if (!workshop) return
    if (createRequest === "universe") {
      setNewProject({ workshop, kind: "universe" })
    } else {
      setNewProject({ workshop, kind: "story" })
    }
  }, [catalog, createRequest, workshop])

  // The operation that makes the missing link properties of anchors and arcs; the first binding
  // needs them, and so does an anchor made as an event of a universe.
  const { ensure: ensurePlot, ensureAnchorLinks } = usePlotEnsurer(onCreativeChanged)
  // "Create the missing sections" of a workshop made before every base was made at once.
  const completion = useCompleteWorkshop(workshop, async () => {
    await onCreativeChanged?.()
    useCreativeNavStore.getState().bumpData()
  })

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
    /** The workshop whose anchors may need a relation to the base that was just made. */
    anchorsOf?: string,
    /** What goes on once the catalog is read again and before the page opens; it shows its own failures. */
    between?: () => Promise<void>,
  ) => {
    await onCreativeChanged?.()
    await useProjectStore.getState().refresh?.()
    if (between) await between()
    if (anchorsOf) {
      try {
        await ensureAnchorLinks(anchorsOf)
      } catch (caught) {
        setLinkNotice(t("creative.plot.linksFailed", { message: projectErrorText(t, caught) }))
      }
    }
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

  // The writes that link a section to the stories and a story to a universe.
  const { addLinks, putStoryInUniverse } = useStoryLinks(onCreativeChanged)
  /** Links a section of an older workshop and reads the catalog again; rejects on failure. */
  const linkSection = async (target: WorkshopSummary, sectionId: string) => {
    if (vaultGeneration === null) return
    await addLinks(target, sectionId, vaultGeneration)
  }

  /**
   * A story made while a universe is chosen is in it from the start. A failure never undoes the
   * story: it stays, under "Standalone stories", and the author is told why.
   */
  const linkNewStory = async (
    created: CreatedItemResult,
    universeId: string,
    workshopId: string,
  ) => {
    try {
      await putStoryInUniverse(created, universeId, workshopId)
      // Shown at once: the lists read the cards again, and the story is not "outside" meanwhile.
      const nav = useCreativeNavStore.getState()
      nav.setFreshStoryId(created.id)
      nav.setStoryFilter(created.id)
      remember({ story: created.id })
    } catch (caught) {
      setLinkNotice(
        t("creative.workshop.link.storyUniverseFailed", { message: projectErrorText(t, caught) }),
      )
    } finally {
      bumpData()
    }
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
    }
  }

  const settingsButton = onOpenSettings ? (
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
  // The workshop's own page (every section, the whole workshop) is reached from its title.
  const header = (
    <PanelHeader
      title={t("panels.creative")}
      actions={
        workshop || settingsButton ? (
          <>
            {workshop && (
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("creative.workshop.openWorkshop")}
                aria-label={t("creative.workshop.openWorkshop")}
                onClick={() => openProject(workshop.workshopId)}
              >
                <ExternalLink className="size-4" />
              </Button>
            )}
            {settingsButton}
          </>
        ) : undefined
      }
    />
  )

  const legacyFolders = catalog?.diagnostics.filter((d) => d.code === "legacyProjectFormat") ?? []
  const attention = catalog?.diagnostics.filter((d) => d.code !== "legacyProjectFormat") ?? []
  const gaps = workshop ? workshopGaps(workshop) : null
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
  } else if (!workshop) {
    body = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DiagnosticsNotice diagnostics={attention} />
        <WorkshopInitScreen
          path={place.path}
          others={place.others}
          vaultGeneration={vaultGeneration}
          onInitialized={(created) => afterWrite(created.workshopId)}
          onOpenSettings={
            onOpenSettings
              ? () => onOpenSettings({ section: "modules", moduleId: "creative" })
              : undefined
          }
        />
        <LegacyFoldersRow diagnostics={legacyFolders} />
      </div>
    )
  } else {
    body = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DiagnosticsNotice diagnostics={attention} />
        {gaps && hasGaps(gaps) && <CompleteWorkshopNotice gaps={gaps} state={completion} />}
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
          scopeId={workshop.workshopId}
          vault={vault ?? null}
          vaultGeneration={vaultGeneration}
          onOpenNote={openNote}
          activeNoteId={selectedId}
          onOpenProject={openProject}
          universeId={activeUniverseId}
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
        <LegacyFoldersRow diagnostics={legacyFolders} />
      </div>
    )
  }

  const bottom =
    databaseRuntimeEnabled && workshop && status !== "disabled" ? (
      <div className="shrink-0 space-y-2 p-2">
        <Button
          className="w-full gap-2 border border-foreground/10 bg-foreground/10 font-medium text-foreground shadow-sm hover:bg-foreground/15 hover:shadow-md active:shadow-sm focus-visible:ring-1 focus-visible:ring-foreground/20"
          whileTap={{ y: 1, scale: 0.99 }}
          onClick={() => setChooserOpen(true)}
        >
          <Plus className="size-4" />
          {t("creative.panel.create")}
        </Button>
        <UniverseCard
          universes={universes}
          selectedUniverseId={activeUniverseId}
          onSelectUniverse={chooseUniverse}
          onNewUniverse={
            workshop.readOnly
              ? null
              : () => setNewProject({ workshop, kind: "universe", kinds: ["universe"] })
          }
          onOpenTarget={() =>
            openProject(
              activeUniverseId
                ? universeTargetId(activeUniverseId)
                : standaloneTargetId(workshop.workshopId),
            )
          }
        />
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
        kinds={newProject?.kinds}
        onCreated={(created: CreatedItemResult) => {
          if (created.kind === "universe") {
            // The universe made is the one shown from now on.
            justCreatedUniverse.current = created.id
            chooseUniverse(created.id)
          }
          const target = newProject?.workshop ?? workshop
          const intoUniverse =
            created.kind === "story" && activeUniverseId !== null && target !== null
              ? { universeId: activeUniverseId, workshopId: target.workshopId }
              : null
          void afterWrite(
            created.kind === "universe" ? universeTargetId(created.id) : created.id,
            undefined,
            created.kind === "universe" ? target?.workshopId : undefined,
            intoUniverse
              ? () => linkNewStory(created, intoUniverse.universeId, intoUniverse.workshopId)
              : undefined,
          )
        }}
      />
      {sectionRequest && (
        <CreateSectionDialog
          open
          onClose={() => setSectionRequest(null)}
          vaultGeneration={vaultGeneration}
          workshop={sectionRequest.workshop}
          onCreated={(created) =>
            void afterWrite(
              sectionRequest.workshop.workshopId,
              created.section.sectionId,
              sectionRequest.workshop.workshopId,
            )
          }
        />
      )}
    </div>
  )
}
