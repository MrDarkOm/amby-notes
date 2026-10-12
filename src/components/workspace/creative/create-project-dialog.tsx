import * as React from "react"
import { BookOpen, Globe2, Layers, Plus, X } from "lucide-react"
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
import { createProject, type CreatedProject, type ProjectSummary } from "@/lib/storage"
import { projectErrorText } from "./project-error"
import { projectLabels, projectRequestKind, type NewProjectKind } from "./project-labels"
import {
  levelChain,
  levelsProblem,
  MAX_TEXT_LEVELS,
  presetLevelNames,
  TEXT_SCHEMAS,
  type TextSchemaChoice,
} from "./text-schema-presets"
import { useOperationId } from "./use-operation-id"

const KIND_ICONS = { story: BookOpen, universe: Globe2, collection: Layers } as const

interface CreateProjectDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  /** The collection the project is created inside; none means the vault root. */
  parent?: ProjectSummary | null
  /** The kinds offered instead of the default for the parent. */
  kinds?: NewProjectKind[]
  /** The kind selected on open; the first offered kind when absent. */
  initialKind?: NewProjectKind
  onCreated: (created: CreatedProject) => void
}

export function CreateProjectDialog({
  open,
  onClose,
  vaultGeneration,
  parent = null,
  kinds: offeredKinds,
  initialKind,
  onCreated,
}: CreateProjectDialogProps) {
  const { t } = useTranslation()
  // Inside a collection only a story makes sense: a collection cannot nest.
  const kinds: NewProjectKind[] =
    offeredKinds ?? (parent ? ["story"] : ["story", "universe", "collection"])
  const startKind: NewProjectKind = initialKind ?? kinds[0] ?? "story"
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<NewProjectKind>(startKind)
  const [schema, setSchema] = React.useState<TextSchemaChoice>("novel")
  // The author's own list; it starts from the schema that was chosen before it.
  const [customLevels, setCustomLevels] = React.useState<string[]>([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const parentPath = parent?.path ?? null
  const trimmed = name.trim()

  // Only a story has a text, so only a story chooses its levels.
  const levelNames = React.useMemo(
    () => (schema === "custom" ? customLevels : presetLevelNames(schema, t)),
    [schema, customLevels, t],
  )
  const textLevels = kind === "story" ? levelNames.map((level) => level.trim()) : null
  const problem = textLevels ? levelsProblem(textLevels) : null
  const operationId = useOperationId("create-project", {
    name: trimmed,
    kind,
    parentPath,
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
      const shape = projectRequestKind(kind)
      const created = await createProject({
        expectedGeneration: vaultGeneration,
        operationId: operationId(),
        kind: shape.kind,
        name: trimmed,
        parentPath,
        baseSections: shape.baseSections,
        labels: projectLabels(t),
        ...(textLevels ? { textLevels } : {}),
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
            <DialogTitle>{t("creative.createProject.title")}</DialogTitle>
            <DialogDescription>
              {parent
                ? t("creative.createProject.insideCollection", { name: parent.name })
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
