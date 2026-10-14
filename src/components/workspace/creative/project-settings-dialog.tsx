import * as React from "react"
import { ArrowDown, ArrowUp, FileText, Globe2, Plus, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  addTextStatus,
  removeWorkshopSection,
  renameDatabase,
  reorderWorkshopSections,
  updateTextLevels,
  updateWorkshop,
  type StorySummary,
  type WorkshopSectionSummary,
  type WorkshopSummary,
} from "@/lib/storage"
import { cn } from "@/lib/utils"
import { useDatabaseStore } from "../database/database-store"
import { IconPickerButton } from "../database/icon-picker-button"
import { projectErrorText } from "./project-error"
import { statusLabels } from "./project-labels"
import { useProjectStore } from "./project-store"
import { sectionRoleIcon } from "./section-icons"
import { levelsProblem, MAX_TEXT_LEVELS } from "./text-schema-presets"
import { useOperationId } from "./use-operation-id"

type SettingsTab = "general" | "sections" | "levels"

interface EditableLevel {
  key: string
  id: string | null
  name: string
  icon: string | null
}

interface ProjectSettingsDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  workshop?: WorkshopSummary | null
  story?: StorySummary | null
  project?: WorkshopSummary | StorySummary | null
  onChanged?: () => Promise<void>
  onAddSection?: () => void
}

function DefaultProjectIcon({
  workshop: _workshop,
  className,
}: {
  workshop?: WorkshopSummary | null
  className?: string
}) {
  return <Globe2 className={className} />
}

export function ProjectSettingsDialog({
  open,
  onClose,
  vaultGeneration,
  workshop,
  story,
  project,
  onChanged,
  onAddSection,
}: ProjectSettingsDialogProps) {
  const { t } = useTranslation()
  const databases = useDatabaseStore((state) => state.databases)
  const catalog = useProjectStore((state) => state.catalog)

  const resolvedWorkshop: WorkshopSummary | null =
    workshop ??
    (project && "workshopId" in project
      ? (project as WorkshopSummary)
      : (catalog?.workshops.find((w) =>
          project && "storyId" in project
            ? w.stories.some((s) => s.storyId === (project as StorySummary).storyId)
            : true,
        ) ?? null))

  const resolvedStory: StorySummary | null =
    story ?? (project && "storyId" in project ? (project as StorySummary) : null)

  const hasLevelsTab = Boolean(resolvedStory && resolvedStory.text !== null)
  const sections: WorkshopSectionSummary[] = resolvedWorkshop?.sections ?? []

  const [tab, setTab] = React.useState<SettingsTab>("general")
  const [name, setName] = React.useState(resolvedWorkshop?.name ?? "")
  const [icon, setIcon] = React.useState(resolvedWorkshop?.icon ?? "")
  const [tagsText, setTagsText] = React.useState((resolvedWorkshop?.tags ?? []).join(", "))
  const [sectionNames, setSectionNames] = React.useState<Record<string, string>>({})
  const [confirmingSectionId, setConfirmingSectionId] = React.useState<string | null>(null)
  const [levels, setLevels] = React.useState<EditableLevel[]>([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const newLevelSeqRef = React.useRef(0)

  React.useEffect(() => {
    if (!open || !resolvedWorkshop) return
    setName(resolvedWorkshop.name)
    setIcon(resolvedWorkshop.icon ?? "")
    setTagsText(resolvedWorkshop.tags.join(", "))
    setSectionNames(
      Object.fromEntries(
        resolvedWorkshop.sections.map((section) => [
          section.id,
          section.databaseName ?? section.id,
        ]),
      ),
    )
    setConfirmingSectionId(null)
    setLevels(
      (resolvedStory?.text?.levels ?? []).map((level) => ({
        key: level.id,
        id: level.id,
        name: level.name ?? "",
        icon: level.icon ?? null,
      })),
    )
    setError(null)
    setPending(false)
  }, [open, resolvedWorkshop, resolvedStory])

  const trimmedName = name.trim()
  const parsedTags = React.useMemo(
    () =>
      tagsText
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    [tagsText],
  )

  const updateWorkshopOpId = useOperationId("update-workshop", {
    workshop: resolvedWorkshop?.workshopId,
    revision: resolvedWorkshop?.fileRevision,
    name: trimmedName,
    icon,
    tags: parsedTags,
  })
  const reorderSectionsOpId = useOperationId("reorder-workshop-sections", {
    workshop: resolvedWorkshop?.workshopId,
    revision: resolvedWorkshop?.fileRevision,
    sections: sections.map((section) => section.id),
  })
  const removeSectionOpId = useOperationId("remove-workshop-section", {
    workshop: resolvedWorkshop?.workshopId,
    revision: resolvedWorkshop?.fileRevision,
    confirmingSectionId,
  })
  const updateLevelsOpId = useOperationId("update-text-levels", {
    story: resolvedStory?.storyId,
    revision: resolvedStory?.fileRevision,
    levels: levels.map((level) => ({ id: level.id, name: level.name.trim(), icon: level.icon })),
  })
  const addStatusOpId = useOperationId("add-text-status", {
    story: resolvedStory?.storyId,
    revision: resolvedStory?.fileRevision,
  })

  const refreshAll = async () => {
    await onChanged?.()
    await useProjectStore.getState().refresh?.()
  }

  const handleSaveGeneral = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!trimmedName || pending || vaultGeneration === null || !resolvedWorkshop) return
    setPending(true)
    setError(null)
    try {
      await updateWorkshop({
        expectedGeneration: vaultGeneration,
        operationId: updateWorkshopOpId(),
        workshopId: resolvedWorkshop.workshopId,
        expectedWorkshopRevision: resolvedWorkshop.fileRevision,
        name: trimmedName,
        icon: icon.trim() ? icon.trim() : null,
        tags: parsedTags,
      })
      await refreshAll()
      onClose()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setPending(false)
    }
  }

  const handleRenameSection = async (
    sectionId: string,
    databaseId: string,
    currentName: string,
  ) => {
    const nextName = (sectionNames[sectionId] ?? currentName).trim()
    if (!nextName || nextName === currentName || pending || vaultGeneration === null) {
      setSectionNames((prev) => ({ ...prev, [sectionId]: currentName }))
      return
    }
    const dbSummary = databases.find((candidate) => candidate.databaseId === databaseId)
    setPending(true)
    setError(null)
    try {
      await renameDatabase({
        expectedGeneration: vaultGeneration,
        databaseId,
        expectedManifestRevision: dbSummary?.manifestRevision ?? "",
        name: nextName,
      })
      await refreshAll()
    } catch (caught) {
      setError(projectErrorText(t, caught))
      setSectionNames((prev) => ({ ...prev, [sectionId]: currentName }))
    } finally {
      setPending(false)
    }
  }

  const handleMoveSection = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (
      targetIndex < 0 ||
      targetIndex >= sections.length ||
      pending ||
      vaultGeneration === null ||
      !resolvedWorkshop
    ) {
      return
    }
    const sectionIds = sections.map((section) => section.id)
    const [moved] = sectionIds.splice(index, 1)
    sectionIds.splice(targetIndex, 0, moved)

    setPending(true)
    setError(null)
    try {
      await reorderWorkshopSections({
        expectedGeneration: vaultGeneration,
        operationId: reorderSectionsOpId(),
        workshopId: resolvedWorkshop.workshopId,
        expectedWorkshopRevision: resolvedWorkshop.fileRevision,
        sectionIds,
      })
      await refreshAll()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setPending(false)
    }
  }

  const handleRemoveSection = async (sectionId: string) => {
    if (pending || vaultGeneration === null || !resolvedWorkshop) return
    setPending(true)
    setError(null)
    try {
      await removeWorkshopSection({
        expectedGeneration: vaultGeneration,
        operationId: removeSectionOpId(),
        workshopId: resolvedWorkshop.workshopId,
        expectedWorkshopRevision: resolvedWorkshop.fileRevision,
        sectionId,
      })
      setConfirmingSectionId(null)
      await refreshAll()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setPending(false)
    }
  }

  const levelNames = levels.map((level) => level.name)
  const levelProblem = hasLevelsTab ? levelsProblem(levelNames) : null

  const handleMoveLevel = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= levels.length) return
    setLevels((prev) => {
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
    setError(null)
  }

  const handleAddLevel = () => {
    if (levels.length >= MAX_TEXT_LEVELS) return
    newLevelSeqRef.current += 1
    setLevels((prev) => [
      ...prev,
      {
        key: `new-${newLevelSeqRef.current}`,
        id: null,
        name: "",
        icon: null,
      },
    ])
    setError(null)
  }

  const handleSaveLevels = async () => {
    if (levelProblem || pending || vaultGeneration === null || !resolvedStory) return
    setPending(true)
    setError(null)
    try {
      await updateTextLevels({
        expectedGeneration: vaultGeneration,
        operationId: updateLevelsOpId(),
        storyId: resolvedStory.storyId,
        expectedStoryRevision: resolvedStory.fileRevision,
        levels: levels.map((level) => ({
          id: level.id,
          name: level.name.trim(),
          icon: level.icon && level.icon.trim() ? level.icon.trim() : null,
        })),
      })
      await refreshAll()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setPending(false)
    }
  }

  const handleAddStatus = async () => {
    if (pending || vaultGeneration === null || !resolvedStory) return
    setPending(true)
    setError(null)
    try {
      await addTextStatus({
        expectedGeneration: vaultGeneration,
        operationId: addStatusOpId(),
        storyId: resolvedStory.storyId,
        expectedStoryRevision: resolvedStory.fileRevision,
        labels: statusLabels(t),
      })
      await refreshAll()
    } catch (caught) {
      setError(projectErrorText(t, caught))
    } finally {
      setPending(false)
    }
  }

  const tabButtonClass = (active: boolean) =>
    cn(
      "rounded-md px-3 py-1.5 text-xs font-medium",
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    )

  if (!resolvedWorkshop) return null

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle>{t("creative.projectSettings.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1 border-b border-border pb-2" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "general"}
            className={tabButtonClass(tab === "general")}
            onClick={() => {
              setTab("general")
              setError(null)
            }}
          >
            {t("creative.projectSettings.tabs.general")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sections"}
            className={tabButtonClass(tab === "sections")}
            onClick={() => {
              setTab("sections")
              setError(null)
            }}
          >
            {t("creative.projectSettings.tabs.sections")}
          </button>
          {hasLevelsTab && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "levels"}
              className={tabButtonClass(tab === "levels")}
              onClick={() => {
                setTab("levels")
                setError(null)
              }}
            >
              {t("creative.projectSettings.tabs.levels")}
            </button>
          )}
        </div>

        {tab === "general" && (
          <form onSubmit={handleSaveGeneral} className="flex flex-col gap-4">
            <div className="flex items-end gap-2.5">
              <div className="flex flex-col gap-1.5 text-xs font-medium">
                <span>{t("creative.projectSettings.icon")}</span>
                <IconPickerButton
                  value={icon || undefined}
                  fallback={<DefaultProjectIcon workshop={resolvedWorkshop} className="size-5" />}
                  label={t("creative.projectSettings.changeIcon")}
                  onChange={(next) => setIcon(next)}
                  disabled={pending}
                  className="size-9 border border-border bg-card"
                  iconClassName="size-5"
                />
              </div>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium">
                {t("creative.projectSettings.name")}
                <Input
                  autoFocus
                  value={name}
                  maxLength={100}
                  disabled={pending}
                  onChange={(event) => {
                    setName(event.target.value)
                    setError(null)
                  }}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1.5 text-xs font-medium">
              {t("creative.projectSettings.tags")}
              <Input
                value={tagsText}
                placeholder={t("creative.projectSettings.tagsPlaceholder")}
                disabled={pending}
                onChange={(event) => {
                  setTagsText(event.target.value)
                  setError(null)
                }}
              />
              <span className="text-[11px] font-normal text-muted-foreground">
                {t("creative.projectSettings.tagsHint")}
              </span>
            </label>

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                {t("creative.projectSettings.close")}
              </Button>
              <Button type="submit" disabled={!trimmedName || pending || vaultGeneration === null}>
                {pending
                  ? t("creative.projectSettings.saving")
                  : t("creative.projectSettings.save")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {tab === "sections" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t("creative.projectSettings.sectionsHint")}
            </p>

            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
              {sections.map((section, index) => {
                const Icon = sectionRoleIcon(section.role)
                const currentName = section.databaseName ?? section.id
                const draftName = sectionNames[section.id] ?? currentName
                const isTextSection = section.role === "text"
                const isConfirming = confirmingSectionId === section.id

                return (
                  <div
                    key={section.id}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-card/50 p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <Input
                        aria-label={currentName}
                        value={draftName}
                        maxLength={100}
                        disabled={pending || section.state === "missing"}
                        className="h-8 flex-1 text-xs"
                        onChange={(event) =>
                          setSectionNames((prev) => ({
                            ...prev,
                            [section.id]: event.target.value,
                          }))
                        }
                        onBlur={() =>
                          void handleRenameSection(section.id, section.databaseId, currentName)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void handleRenameSection(section.id, section.databaseId, currentName)
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={t("creative.projectSettings.moveUp")}
                        title={t("creative.projectSettings.moveUp")}
                        disabled={index === 0 || pending}
                        onClick={() => void handleMoveSection(index, -1)}
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={t("creative.projectSettings.moveDown")}
                        title={t("creative.projectSettings.moveDown")}
                        disabled={index === sections.length - 1 || pending}
                        onClick={() => void handleMoveSection(index, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={t("creative.projectSettings.unlinkSection")}
                        title={
                          isTextSection
                            ? t("creative.projectSettings.textSectionFixed")
                            : t("creative.projectSettings.unlinkSection")
                        }
                        disabled={isTextSection || pending}
                        onClick={() => setConfirmingSectionId(section.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>

                    {isConfirming && (
                      <div className="flex items-center justify-between gap-2 rounded-md bg-accent/60 px-2.5 py-1.5 text-xs">
                        <span className="text-muted-foreground">
                          {t("creative.projectSettings.unlinkConfirm", { name: currentName })}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={pending}
                            onClick={() => setConfirmingSectionId(null)}
                          >
                            {t("common.cancel")}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={pending}
                            onClick={() => void handleRemoveSection(section.id)}
                          >
                            {t("creative.projectSettings.confirmUnlink")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {onAddSection && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    onClose()
                    onAddSection()
                  }}
                >
                  <Plus className="size-3.5" />
                  {t("creative.projectSettings.addSection")}
                </Button>
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                {t("creative.projectSettings.close")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {tab === "levels" && hasLevelsTab && resolvedStory?.text && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5">
              <p className="text-xs text-muted-foreground">
                {t("creative.projectSettings.levelsHint", { max: MAX_TEXT_LEVELS })}
              </p>

              <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
                {levels.map((level, index) => (
                  <div key={level.key} className="flex items-center gap-1.5">
                    <IconPickerButton
                      value={level.icon ?? undefined}
                      fallback={<FileText className="size-4 text-muted-foreground" />}
                      label={t("creative.projectSettings.levelIcon", { number: index + 1 })}
                      onChange={(next) =>
                        setLevels((prev) =>
                          prev.map((item, idx) =>
                            idx === index ? { ...item, icon: next || null } : item,
                          ),
                        )
                      }
                      disabled={pending}
                      className="size-8 border border-border bg-card"
                      iconClassName="size-4"
                    />
                    <Input
                      aria-label={t("creative.createProject.textSchema.levelName", {
                        number: index + 1,
                      })}
                      value={level.name}
                      maxLength={100}
                      disabled={pending}
                      className="h-8 flex-1 text-xs"
                      onChange={(event) => {
                        const nextName = event.target.value
                        setLevels((prev) =>
                          prev.map((item, idx) =>
                            idx === index ? { ...item, name: nextName } : item,
                          ),
                        )
                        setError(null)
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={t("creative.projectSettings.moveUp")}
                      title={t("creative.projectSettings.moveUp")}
                      disabled={index === 0 || pending}
                      onClick={() => handleMoveLevel(index, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label={t("creative.projectSettings.moveDown")}
                      title={t("creative.projectSettings.moveDown")}
                      disabled={index === levels.length - 1 || pending}
                      onClick={() => handleMoveLevel(index, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    {level.id === null && levels.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={t("creative.createProject.textSchema.removeLevel", {
                          number: index + 1,
                        })}
                        disabled={pending}
                        onClick={() => setLevels((prev) => prev.filter((_, idx) => idx !== index))}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {levelProblem && (
                <p className="text-xs text-destructive">
                  {t(`creative.createProject.textSchema.problem.${levelProblem}`, {
                    max: MAX_TEXT_LEVELS,
                  })}
                </p>
              )}

              <div className="flex items-center justify-between gap-2">
                {levels.length < MAX_TEXT_LEVELS ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={handleAddLevel}
                  >
                    <Plus className="size-3.5" />
                    {t("creative.projectSettings.addLevel")}
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(levelProblem) || pending || vaultGeneration === null}
                  onClick={() => void handleSaveLevels()}
                >
                  {pending
                    ? t("creative.projectSettings.saving")
                    : t("creative.projectSettings.saveLevels")}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <h3 className="text-xs font-semibold">{t("creative.projectSettings.statusTitle")}</h3>
              {resolvedStory.text.properties.status ? (
                <p className="text-xs text-muted-foreground">
                  {t("creative.projectSettings.statusConfigured")}
                </p>
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t("creative.projectSettings.statusNotConfigured")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || vaultGeneration === null}
                    onClick={() => void handleAddStatus()}
                  >
                    {pending
                      ? t("creative.projectSettings.addingStatus")
                      : t("creative.projectSettings.addStatus")}
                  </Button>
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                {t("creative.projectSettings.close")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
