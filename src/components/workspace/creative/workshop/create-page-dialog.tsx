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
import { createTextPage, type CreatedTextPage, type ProjectSummary } from "@/lib/storage"
import { projectErrorText } from "../project-error"
import { defaultLevelId, lastOrderKey, type TextNode } from "./text-tree-model"

interface CreatePageDialogProps {
  open: boolean
  onClose: () => void
  vaultGeneration: number | null
  stories: ProjectSummary[]
  /** The story preselected, e.g. the one the page was asked for in. */
  storyId: string | null
  /** The page it goes under; none puts it at the top of the text. */
  parent: TextNode | null
  /** The level it starts at, when it is not the one below its parent (e.g. an arc at the top). */
  levelId?: string | null
  /** The roots of each story's tree, to place the page last among its siblings. */
  rootsOf: (storyId: string) => TextNode[]
  onCreated: (created: CreatedTextPage, story: ProjectSummary) => void
}

/** Title, level and format of a new page of a story's text. */
export function CreatePageDialog({
  open,
  onClose,
  vaultGeneration,
  stories,
  storyId,
  parent,
  levelId: startLevelId = null,
  rootsOf,
  onCreated,
}: CreatePageDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = React.useState("")
  const [story, setStory] = React.useState(storyId ?? stories[0]?.projectId ?? "")
  const [levelId, setLevelId] = React.useState("")
  const [formatId, setFormatId] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const project = stories.find((candidate) => candidate.projectId === story) ?? stories[0] ?? null
  const text = project?.text ?? null
  const levels = React.useMemo(
    () => (text?.levels ?? []).filter((level) => level.state === "ok"),
    [text],
  )
  const formats = React.useMemo(
    () => (text?.formats ?? []).filter((format) => format.state === "ok"),
    [text],
  )

  React.useEffect(() => {
    if (!open) return
    setTitle("")
    setStory(storyId ?? stories[0]?.projectId ?? "")
    setError(null)
    setPending(false)
    // Opening is the only moment the defaults are set; later edits are the author's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  React.useEffect(() => {
    if (!open || !text) return
    const forced = startLevelId && text.levels.some((level) => level.id === startLevelId)
    setLevelId(forced ? startLevelId : (defaultLevelId(text.levels, parent) ?? ""))
    setFormatId((formats.find((format) => format.kind === "manuscript") ?? formats[0])?.id ?? "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, story])

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || pending || vaultGeneration === null || !project || !levelId) return
    setPending(true)
    setError(null)
    try {
      const siblings = parent ? parent.children : rootsOf(project.projectId)
      const created = await createTextPage({
        expectedGeneration: vaultGeneration,
        projectId: project.projectId,
        title: trimmed,
        parentNoteId: parent?.noteId ?? null,
        levelId,
        formatId: formatId || null,
        orderKey: lastOrderKey(siblings),
      })
      onCreated(created, project)
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
            <DialogTitle>{t("creative.workshop.page.title")}</DialogTitle>
            <DialogDescription>
              {parent
                ? t("creative.workshop.page.under", { name: parent.title })
                : t("creative.workshop.page.atTop")}
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("creative.workshop.page.name")}
            <Input
              autoFocus
              value={title}
              maxLength={100}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setTitle(event.target.value)
                setError(null)
              }}
            />
          </label>

          {stories.length > 1 && !parent && (
            <div className="flex flex-col gap-1.5 text-xs font-medium">
              {t("creative.workshop.page.story")}
              <AmbySelect
                aria-label={t("creative.workshop.page.story")}
                value={story}
                onValueChange={setStory}
                options={stories.map((entry) => ({ value: entry.projectId, label: entry.name }))}
              />
            </div>
          )}

          {levels.length > 0 && (
            <div className="flex flex-col gap-1.5 text-xs font-medium">
              {t("creative.workshop.page.level")}
              <AmbySelect
                aria-label={t("creative.workshop.page.level")}
                value={levelId}
                onValueChange={setLevelId}
                options={levels.map((level) => ({
                  value: level.id,
                  label: level.name ?? level.id,
                }))}
              />
            </div>
          )}

          {formats.length > 0 && (
            <div className="flex flex-col gap-1.5 text-xs font-medium">
              {t("creative.workshop.page.format")}
              <AmbySelect
                aria-label={t("creative.workshop.page.format")}
                value={formatId}
                onValueChange={setFormatId}
                options={formats.map((format) => ({
                  value: format.id,
                  label: format.name ?? format.kind,
                }))}
              />
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
            <Button type="submit" disabled={!title.trim() || pending || !levelId}>
              {pending ? t("creative.workshop.page.creating") : t("creative.workshop.page.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
