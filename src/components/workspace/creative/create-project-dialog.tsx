import * as React from "react"
import { BookOpen, Globe2, Layers } from "lucide-react"
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
import { useOperationId } from "./use-operation-id"

const KIND_ICONS = { story: BookOpen, universe: Globe2, collection: Layers } as const

interface CreateProjectDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  /** The collection the project is created inside; none means the vault root. */
  parent?: ProjectSummary | null
  onCreated: (created: CreatedProject) => void
}

export function CreateProjectDialog({
  open,
  onClose,
  vaultGeneration,
  parent = null,
  onCreated,
}: CreateProjectDialogProps) {
  const { t } = useTranslation()
  // Inside a collection only a story makes sense: a collection cannot nest.
  const kinds: NewProjectKind[] = parent ? ["story"] : ["story", "universe", "collection"]
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<NewProjectKind>("story")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const parentPath = parent?.path ?? null
  const operationId = useOperationId("create-project", { name: name.trim(), kind, parentPath })
  const trimmed = name.trim()

  React.useEffect(() => {
    if (open) {
      setName("")
      setKind("story")
      setError(null)
      setPending(false)
    }
  }, [open])

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!trimmed || pending || vaultGeneration === null) return
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
              {pending ? t("creative.createProject.creating") : t("creative.createProject.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
