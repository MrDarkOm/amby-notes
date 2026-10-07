import * as React from "react"
import { Check, Star, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { PickerShell } from "./picker-shell"
import { OPTION_COLORS, STATUS_GROUPS, type OptionDraft, type StatusGroup } from "./option-model"

const ITEM =
  "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-50"

interface OptionEditMenuProps {
  draft: OptionDraft
  status: boolean
  /** Saves a change of the option; rejects with the reason, shown under the name. */
  onChange: (patch: Partial<OptionDraft>) => Promise<void>
  onRemove: () => Promise<void> | void
  onDone: () => void
}

/**
 * What can be done to one option, in one small menu: its name (typed on the spot), Delete, and the
 * colors by name with a tick on the current one (for a Status also the group it belongs to).
 */
export function OptionEditMenu({ draft, status, onChange, onRemove, onDone }: OptionEditMenuProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(draft.name)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => setName(draft.name), [draft.name])

  const run = async (action: () => Promise<void> | void) => {
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      throw failure
    }
  }
  const commitName = () => {
    const next = name.trim()
    if (next === draft.name) return Promise.resolve()
    return run(() => onChange({ name: next })).catch(() => setName(draft.name))
  }

  return (
    <div className="flex w-full flex-col gap-0.5">
      <input
        autoFocus
        value={name}
        maxLength={80}
        aria-label={t("databaseOptions.name")}
        placeholder={t("databaseOptions.namePlaceholder")}
        className="mb-1 h-9 w-full rounded-md border border-border bg-muted/40 px-2.5 text-[13px] font-medium outline-none focus:border-ring focus:bg-background"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => void commitName()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Enter") {
            event.preventDefault()
            void commitName().then(onDone)
          }
          if (event.key === "Escape") setName(draft.name)
        }}
      />
      {error && (
        <p role="alert" className="px-1 pb-1 text-xs leading-snug text-destructive">
          {error}
        </p>
      )}
      <button
        type="button"
        className={ITEM}
        onClick={() => void run(() => onChange({ isDefault: !draft.isDefault })).catch(() => {})}
      >
        <Star
          className={cn("size-3.5", draft.isDefault ? "fill-current" : "text-muted-foreground")}
        />
        <span className="flex-1">{t("databaseOptions.makeDefault")}</span>
        {draft.isDefault && <Check className="size-3.5" />}
      </button>
      <button
        type="button"
        className={cn(ITEM, "text-destructive hover:text-destructive")}
        onClick={() => {
          onDone()
          void Promise.resolve(onRemove())
        }}
      >
        <Trash2 className="size-3.5" />
        {t("databaseOptions.delete")}
      </button>
      {status && (
        <>
          <Divider />
          <p className="px-2 pb-0.5 text-[11px] font-medium text-muted-foreground">
            {t("databaseOptions.group")}
          </p>
          {STATUS_GROUPS.map((group) => (
            <button
              key={group}
              type="button"
              className={ITEM}
              onClick={() =>
                void run(() => onChange({ group: group as StatusGroup })).catch(() => {})
              }
            >
              <span className="flex-1">{t(`databaseOptions.group_${group}`)}</span>
              {draft.group === group && <Check className="size-3.5" />}
            </button>
          ))}
        </>
      )}
      <Divider />
      <p className="px-2 pb-0.5 text-[11px] font-medium text-muted-foreground">
        {t("databaseOptions.colors")}
      </p>
      {OPTION_COLORS.map((color) => (
        <button
          key={color.id}
          type="button"
          className={ITEM}
          onClick={() => void run(() => onChange({ color: color.hex })).catch(() => {})}
        >
          <span
            aria-hidden="true"
            className="size-5 shrink-0 rounded-[5px] border border-black/10"
            style={{ backgroundColor: `color-mix(in srgb, ${color.hex} 35%, white)` }}
          />
          <span className="flex-1">{t(`databaseOptions.colorNames.${color.id}`)}</span>
          {draft.color.toLowerCase() === color.hex && <Check className="size-3.5" />}
        </button>
      ))}
    </div>
  )
}

function Divider() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-border" />
}

/**
 * Opens the menu of one option beside its row (inside a menu it unfolds under the row instead, so
 * a menu never covers another). `children` is the control that opens it.
 */
export function OptionMenuTrigger({
  draft,
  status,
  onChange,
  onRemove,
  trigger,
}: Omit<OptionEditMenuProps, "onDone"> & { trigger: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <PickerShell
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      side="right"
      popoverClassName="w-60 p-2"
      inlineClassName="p-2"
    >
      <OptionEditMenu
        draft={draft}
        status={status}
        onChange={onChange}
        onRemove={onRemove}
        onDone={() => setOpen(false)}
      />
    </PickerShell>
  )
}
