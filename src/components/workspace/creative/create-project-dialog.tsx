import * as React from "react"
import { BookOpen, Globe2, Plus, X } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  createStory,
  createWorkshopEntity,
  createWorkshopSection,
  type WorkshopSummary,
} from "@/lib/storage"
import { projectErrorText } from "./project-error"
import { projectLabels } from "./project-labels"
import {
  levelChain,
  levelsProblem,
  MAX_TEXT_LEVELS,
  presetLevelNames,
  TEXT_SCHEMAS,
  type TextSchemaChoice,
} from "./text-schema-presets"
import { useOperationId } from "./use-operation-id"

export type CreativeCreationKind = "story" | "universe"

export interface CreatedItemResult {
  kind: CreativeCreationKind
  id: string
  /** A story's card (its row in the stories base), as the creation answered it. */
  cardNoteId?: string
}

const KIND_ICONS = {
  story: BookOpen,
  universe: Globe2,
} as const

interface CreateProjectDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  workshop?: WorkshopSummary | null
  kinds?: CreativeCreationKind[]
  initialKind?: CreativeCreationKind
  onCreated: (created: CreatedItemResult) => void
}

export function CreateProjectDialog({
  open,
  onClose,
  vaultGeneration,
  workshop = null,
  kinds: offeredKinds,
  initialKind,
  onCreated,
}: CreateProjectDialogProps) {
  const { t } = useTranslation()
  const kinds: CreativeCreationKind[] = offeredKinds ?? ["story", "universe"]
  const startKind: CreativeCreationKind = initialKind ?? kinds[0] ?? "story"
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<CreativeCreationKind>(startKind)
  const [schema, setSchema] = React.useState<TextSchemaChoice>("novel")
  const [customLevels, setCustomLevels] = React.useState<string[]>([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const trimmed = name.trim()

  const levelNames = React.useMemo(
    () => (schema === "custom" ? customLevels : presetLevelNames(schema, t)),
    [schema, customLevels, t],
  )
  const textLevels = kind === "story" ? levelNames.map((level) => level.trim()) : null
  const problem = textLevels ? levelsProblem(textLevels) : null
  const operationId = useOperationId("create-creative", {
    name: trimmed,
    kind,
    workshopId: workshop?.workshopId ?? null,
    textLevels,
  })

  const chooseSchema = (next: TextSchemaChoice) => {
    if (next === "custom" && schema !== "custom" && customLevels.length === 0) {
      setCustomLevels(presetLevelNames(schema, t))
    }
    setSchema(next)
  }

  React.useEffect(() => {
    if (open) {
      setName("")
      setKind(startKind)
      setSchema("novel")
      setCustomLevels([])
      setError(null)
      setPending(false)
    }
  }, [open, startKind])

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!trimmed || pending || vaultGeneration === null || problem) return
    setPending(true)
    setError(null)
    try {
      if (kind === "story") {
        if (!workshop) throw new Error(t("creative.errors.projectNotFound"))
        const created = await createStory({
          expectedGeneration: vaultGeneration,
          operationId: operationId(),
          workshopId: workshop.workshopId,
          title: trimmed,
          textLevels: textLevels ?? [],
          labels: projectLabels(t),
        })
        onCreated({ kind: "story", id: created.storyId, cardNoteId: created.cardNoteId })
      } else if (kind === "universe") {
        if (!workshop) throw new Error(t("creative.errors.projectNotFound"))
        // A universe is a page of the "Universes" base, made the way any world page is.
        let sectionId = workshop.sections.find((s) => s.role === "universes")?.id
        if (!sectionId) {
          const sectionRes = await createWorkshopSection({
            expectedGeneration: vaultGeneration,
            operationId: operationId(),
            workshopId: workshop.workshopId,
            expectedWorkshopRevision: workshop.fileRevision,
            role: "universes",
            name: t("creative.sections.universes"),
            labels: projectLabels(t),
          })
          sectionId = sectionRes.section.sectionId
        }
        const created = await createWorkshopEntity({
          expectedGeneration: vaultGeneration,
          workshopId: workshop.workshopId,
          sectionId,
          title: trimmed,
          storyId: null,
        })
        onCreated({ kind: "universe", id: created.noteId })
      }
      onClose()
    } catch (caught) {
      setError(projectErrorText(t, caught))
      setPending(false)
    }
  }

  const titleKey =
    kind === "universe"
      ? "creative.createProject.universeTitle"
      : "creative.createProject.storyTitle"

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-border bg-background text-foreground">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t(titleKey, t("creative.createProject.title"))}</DialogTitle>
            <DialogDescription>
              {workshop
                ? t("creative.createProject.insideCollection", { name: workshop.name })
                : t("creative.createProject.description")}
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("creative.createProject.name")}
            <Input
              autoFocus
              value={name}
              maxLength={100}
              placeholder={t("creative.createProject.namePlaceholder")}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
            />
          </label>

          {kinds.length > 1 && (
            <div
              role="radiogroup"
              aria-label={t("creative.createProject.kind")}
              className="grid gap-2"
            >
              {kinds.map((option) => {
                const Icon = KIND_ICONS[option]
                const selected = option === kind
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setKind(option)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left",
                      selected
                        ? "border-primary bg-accent/60"
                        : "border-border hover:border-primary/40 hover:bg-accent/30",
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{t(`creative.kind.${option}`)}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`creative.kind.${option}Hint`)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {kind === "story" && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium">
                {t("creative.createProject.textSchema.label")}
              </span>
              <div
                role="radiogroup"
                aria-label={t("creative.createProject.textSchema.label")}
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
              >
                {TEXT_SCHEMAS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={option === schema}
                    onClick={() => chooseSchema(option)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm",
                      option === schema
                        ? "border-primary bg-accent/60"
                        : "border-border hover:border-primary/40 hover:bg-accent/30",
                    )}
                  >
                    {t(`creative.schema.presets.${option}`)}
                  </button>
                ))}
              </div>

              {schema === "custom" && (
                <div className="flex flex-col gap-1.5">
                  {customLevels.map((level, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <Input
                        value={level}
                        maxLength={100}
                        aria-label={t("creative.createProject.textSchema.levelName", {
                          number: index + 1,
                        })}
                        onChange={(event) =>
                          setCustomLevels((levels) =>
                            levels.map((entry, at) => (at === index ? event.target.value : entry)),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
                        disabled={customLevels.length <= 1}
                        aria-label={t("creative.createProject.textSchema.removeLevel", {
                          number: index + 1,
                        })}
                        onClick={() =>
                          setCustomLevels((levels) => levels.filter((_, at) => at !== index))
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    disabled={customLevels.length >= MAX_TEXT_LEVELS}
                    onClick={() => setCustomLevels((levels) => [...levels, ""])}
                  >
                    <Plus className="size-3.5" />
                    {t("creative.createProject.textSchema.addLevel")}
                  </Button>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t("creative.createProject.textSchema.chain", {
                  chain: levelChain(levelNames) || "—",
                })}
              </p>
              {problem && (
                <p className="text-xs text-destructive">
                  {t(`creative.createProject.textSchema.problem.${problem}`, {
                    max: MAX_TEXT_LEVELS,
                  })}
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || pending || vaultGeneration === null || problem !== null}
            >
              {pending ? t("creative.createProject.creating") : t("creative.createProject.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
