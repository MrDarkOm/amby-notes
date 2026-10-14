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
import {
  createWorkshopSection,
  type CreatedWorkshopSectionResult,
  type WorkshopSummary,
} from "@/lib/storage"
import { projectErrorText } from "./project-error"
import { projectLabels } from "./project-labels"
import { useOperationId } from "./use-operation-id"

const NO_VALUE = "none"

const SECTION_CHOICES = [
  { value: "characters", role: "characters" },
  { value: "locations", role: "locations" },
  { value: "universes", role: "universes" },
  { value: "arcs", role: "arcs" },
  { value: "anchors", role: "anchors" },
  { value: "notes", role: "notes" },
  { value: "custom", role: "custom" },
] as const

interface CreateSectionDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  workshop?: WorkshopSummary
  project?: WorkshopSummary
  initial?: { name?: string; choice?: string }
  onCreated: (created: CreatedWorkshopSectionResult) => void
}

export function CreateSectionDialog({
  workshop: propWorkshop,
  project,
  ...rest
}: CreateSectionDialogProps) {
  const workshop = propWorkshop ?? project
  if (!workshop) return null
  return <CreateSectionForm workshop={workshop} {...rest} />
}

type CreateSectionFormProps = Omit<CreateSectionDialogProps, "workshop" | "project"> & {
  workshop: WorkshopSummary
}

function CreateSectionForm({
  open,
  onClose,
  vaultGeneration,
  workshop,
  initial,
  onCreated,
}: CreateSectionFormProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState("")
  const [choice, setChoice] = React.useState(NO_VALUE)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const trimmed = name.trim()
  const operationId = useOperationId("create-section", {
    workshop: workshop.workshopId,
    revision: workshop.fileRevision,
    name: trimmed,
    choice,
  })

  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      setChoice(initial?.choice ?? NO_VALUE)
      setError(null)
      setPending(false)
    }
  }, [open, initial])

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!trimmed || pending || vaultGeneration === null) return
    setPending(true)
    setError(null)
    try {
      const chosen = SECTION_CHOICES.find((candidate) => candidate.value === choice)
      const role = chosen ? chosen.role : "custom"
      const created = await createWorkshopSection({
        expectedGeneration: vaultGeneration,
        operationId: operationId(),
        workshopId: workshop.workshopId,
        expectedWorkshopRevision: workshop.fileRevision,
        name: trimmed,
        role,
        labels: projectLabels(t),
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
              {t("creative.createSection.description", { name: workshop.name })}
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

          <div className="flex flex-col gap-1.5 text-xs font-medium">
            {t("creative.createSection.preset")}
            <AmbySelect
              aria-label={t("creative.createSection.preset")}
              value={choice}
              onValueChange={setChoice}
              options={[
                { value: NO_VALUE, label: t("creative.preset.choices.plain", "Пользовательский") },
                ...SECTION_CHOICES.map((entry) => ({
                  value: entry.value,
                  label: t(`creative.preset.choices.${entry.value}`, entry.value),
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
