import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AmbySelect } from "@/components/ui/amby-select"
import { Input } from "@/components/ui/input"
import { createProjectSection, type CreatedSection, type ProjectSummary } from "@/lib/storage"
import { projectErrorText } from "./project-error"
import { projectLabels } from "./project-labels"
import { useOperationId } from "./use-operation-id"

const NO_VALUE = "none"
/**
 * What a new section can start as. A choice sets the role (a hint for the surfaces to offer) and,
 * for the world sections, a preset: starting properties, a gallery grouped by importance and the
 * starter headings of the dossier. The text is the story's one manuscript and is not offered again.
 */
const CHOICES = [
  { value: "notes", role: "notes", preset: null },
  { value: "characters", role: "characters", preset: "characters" },
  { value: "locations", role: "locations", preset: "locations" },
  { value: "organizations", role: null, preset: "organizations" },
  { value: "items", role: null, preset: "items" },
  // The key, unchanging events of a story: an ordinary database whose role the Works tab reads.
  { value: "anchors", role: "anchors", preset: null },
] as const

interface CreateSectionDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  project: ProjectSummary
  /** The name and the starting point to put in the form when it opens. */
  initial?: { name?: string; choice?: string }
  onCreated: (created: CreatedSection) => void
}

export function CreateSectionDialog({
  open,
  onClose,
  vaultGeneration,
  project,
  initial,
  onCreated,
}: CreateSectionDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState("")
  const [group, setGroup] = React.useState(NO_VALUE)
  const [choice, setChoice] = React.useState(NO_VALUE)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const trimmed = name.trim()
  const operationId = useOperationId("create-section", {
    project: project.projectId,
    revision: project.fileRevision,
    name: trimmed,
    group,
    choice,
  })

  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      // Anchors belong to the work, not the world.
      setGroup(
        initial?.choice === "anchors" && project.groups.some((entry) => entry.id === "work")
          ? "work"
          : NO_VALUE,
      )
      setChoice(initial?.choice ?? NO_VALUE)
      setError(null)
      setPending(false)
    }
  }, [open, initial, project.groups])

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!trimmed || pending || vaultGeneration === null) return
    setPending(true)
    setError(null)
    try {
      const chosen = CHOICES.find((candidate) => candidate.value === choice)
      const created = await createProjectSection({
        expectedGeneration: vaultGeneration,
        operationId: operationId(),
        projectId: project.projectId,
        expectedProjectRevision: project.fileRevision,
        name: trimmed,
        role: chosen?.role ?? null,
        preset: chosen?.preset ?? null,
        labels: projectLabels(t),
        groupId: group === NO_VALUE ? null : group,
      })
      onCreated(created)
      onClose()
    } catch (caught) {
      setError(projectErrorText(t, caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-border bg-background text-foreground">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("creative.createSection.title")}</DialogTitle>
            <DialogDescription>
              {t("creative.createSection.description", { name: project.name })}
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("creative.createSection.name")}
            <Input
              autoFocus
              value={name}
              maxLength={100}
              placeholder={t("creative.createSection.namePlaceholder")}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
            />
          </label>

          {project.groups.length > 0 && (
            <div className="flex flex-col gap-1.5 text-xs font-medium">
              {t("creative.createSection.group")}
              <AmbySelect
                aria-label={t("creative.createSection.group")}
                value={group}
                onValueChange={setGroup}
                options={[
                  { value: NO_VALUE, label: t("creative.createSection.noGroup") },
                  ...project.groups.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5 text-xs font-medium">
            {t("creative.createSection.preset")}
            <AmbySelect
              aria-label={t("creative.createSection.preset")}
              value={choice}
              onValueChange={setChoice}
              options={[
                { value: NO_VALUE, label: t("creative.preset.choices.plain") },
                ...CHOICES.filter(
                  (entry) => entry.value !== "anchors" || project.kind === "story",
                ).map((entry) => ({
                  value: entry.value,
                  label: t(`creative.preset.choices.${entry.value}`),
                })),
              ]}
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!trimmed || pending || vaultGeneration === null}>
              {pending ? t("creative.createSection.creating") : t("creative.createSection.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
