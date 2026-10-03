import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { AnimatePresence, Reorder } from "motion/react"
import { useTranslation } from "react-i18next"
import { motionTransition } from "@/lib/motion-config"
import { cardSpring } from "./database-motion"
import { AmbySelect } from "@/components/ui/amby-select"
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
import type { DatabaseOptionResult, DatabasePropertySummary } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { ColorSwatch } from "./option-color-swatch"
import { ReorderableRow } from "./reorderable-row"
import {
  STATUS_GROUPS,
  draftsChanged,
  draftsFromProperty,
  findDraftProblem,
  newDraftKey,
  nextOptionColor,
  type OptionDraft,
  type StatusGroup,
} from "./option-model"

interface PropertyOptionsDialogProps {
  /** The property being edited; `null` closes the dialog. */
  property: DatabasePropertySummary | null
  /** Saves the whole list; rejects with the failure, which the dialog shows. */
  onSave: (propertyId: string, drafts: OptionDraft[]) => Promise<DatabaseOptionResult[]>
  onClose: () => void
}

/** Adds, renames, recolors, reorders and removes the options of a Select, Multi-select or Status. */
export function PropertyOptionsDialog({ property, onSave, onClose }: PropertyOptionsDialogProps) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = React.useState<OptionDraft[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const propertyId = property?.propertyId ?? null
  const status = property?.propertyType === "status"

  React.useEffect(() => {
    setDrafts(property ? draftsFromProperty(property) : [])
    setError(null)
    // The editor restarts from the stored list whenever another property opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId])

  const problem = findDraftProblem(drafts)
  const changed = property ? draftsChanged(drafts, property) : false

  const update = (index: number, patch: Partial<OptionDraft>) =>
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)),
    )
  const move = (index: number, offset: -1 | 1) =>
    setDrafts((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  const add = () => {
    setDrafts((current) => [
      ...current,
      {
        key: newDraftKey(),
        id: null,
        name: "",
        color: nextOptionColor(current),
        group: "notStarted",
      },
    ])
    requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll("input")
      inputs?.[inputs.length - 1]?.focus()
    })
  }

  async function save() {
    if (!property || problem || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(property.propertyId, drafts)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={property !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("databaseOptions.title")}</DialogTitle>
          <DialogDescription>{property?.name}</DialogDescription>
        </DialogHeader>
        <div ref={listRef} className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
          {drafts.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">{t("databaseOptions.empty")}</p>
          )}
          <Reorder.Group axis="y" values={drafts} onReorder={setDrafts} className="space-y-1.5">
            <AnimatePresence initial={false}>
              {drafts.map((draft, index) => {
                const invalid = problem?.index === index
                return (
                  <ReorderableRow
                    key={draft.key}
                    value={draft}
                    disabled={busy}
                    onMove={(offset) => move(index, offset)}
                    className="gap-2"
                    motionProps={{
                      // Added rows slide in and removed ones fold away.
                      initial: { opacity: 0, height: 0 },
                      animate: { opacity: 1, height: "auto" },
                      exit: { opacity: 0, height: 0 },
                      transition: motionTransition(cardSpring),
                    }}
                  >
                    <ColorSwatch
                      color={draft.color}
                      label={t("databaseOptions.color")}
                      disabled={busy}
                      onChange={(hex) => update(index, { color: hex })}
                    />
                    <Input
                      value={draft.name}
                      disabled={busy}
                      maxLength={80}
                      aria-label={t("databaseOptions.name")}
                      aria-invalid={invalid}
                      placeholder={t("databaseOptions.namePlaceholder")}
                      className={cn("h-8 min-w-0 flex-1", invalid && "border-destructive")}
                      onChange={(event) => update(index, { name: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          add()
                        }
                      }}
                    />
                    {status && (
                      <AmbySelect
                        value={draft.group}
                        disabled={busy}
                        aria-label={t("databaseOptions.group")}
                        className="w-28 shrink-0"
                        options={STATUS_GROUPS.map((group) => ({
                          value: group,
                          label: t(`databaseOptions.group_${group}`),
                        }))}
                        onValueChange={(group) => update(index, { group: group as StatusGroup })}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      aria-label={t("databaseOptions.remove")}
                      onClick={() =>
                        setDrafts((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </ReorderableRow>
                )
              })}
            </AnimatePresence>
          </Reorder.Group>
        </div>
        <Button variant="outline" size="sm" className="w-fit gap-1.5" disabled={busy} onClick={add}>
          <Plus className="size-3.5" />
          {t("databaseOptions.add")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("databaseOptions.removeHint")}</p>
        {problem && (
          <p role="alert" className="text-xs text-destructive">
            {t(`databaseOptions.${problem.problem}`)}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || Boolean(problem) || !changed} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
