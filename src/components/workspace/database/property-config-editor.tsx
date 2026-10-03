import * as React from "react"
import { Reorder } from "motion/react"
import { AmbySelect } from "@/components/ui/amby-select"
import { Plus, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import type {
  DatabasePropertySummary,
  DatabaseSummary,
  UpdateDatabasePropertyConfigRequest,
} from "@/lib/storage"
import { cn } from "@/lib/utils"
import { CardTitleInput } from "./layouts/card-title-input"
import { ColorSwatch } from "./option-color-swatch"
import {
  STATUS_GROUPS,
  draftsFromProperty,
  findDraftProblem,
  isOptionProperty,
  newDraftKey,
  nextOptionColor,
  type OptionDraft,
  type StatusGroup,
} from "./option-model"
import type { RelationConfigState } from "./property-settings"
import { Segmented, SettingField, SettingToggle } from "./property-settings-ui"
import { LinkedRelationSettings } from "./relation-settings"
import { ReorderableRow } from "./reorderable-row"
import { RollupSettings } from "./rollup-settings"
import type { RollupDraft } from "./rollup-model"
import { DATE_FORMAT_IDS, dateDisplayOf, formatDateValue } from "./value-format"

/** What a settings change sets; the rest of the request is the property's identity. */
export type PropertyConfigPatch = Omit<
  UpdateDatabasePropertyConfigRequest,
  "expectedGeneration" | "databaseId" | "propertyId" | "expectedManifestRevision"
>

function configOf(property: DatabasePropertySummary): Record<string, unknown> {
  try {
    const config: unknown = JSON.parse(property.configJson)
    return config && typeof config === "object" ? (config as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

interface OptionRowProps {
  draft: OptionDraft
  status: boolean
  locked: boolean
  onName: (name: string) => Promise<void>
  onColor: (color: string) => void
  onGroup: (group: StatusGroup) => void
  onRemove: () => void
  /** Moves the row one place with the keyboard. */
  onMove: (offset: -1 | 1) => void
  /** The row was dropped after dragging. */
  onDropped: () => void
}

/** One option: a grip to drag it, its color, name (and status group), and a remove button. */
function OptionRow({
  draft,
  status,
  locked,
  onName,
  onColor,
  onGroup,
  onRemove,
  onMove,
  onDropped,
}: OptionRowProps) {
  const { t } = useTranslation()
  return (
    <ReorderableRow
      value={draft}
      disabled={locked}
      onMove={onMove}
      onDropped={onDropped}
      className="group/option rounded-lg bg-card px-1 py-1 hover:bg-accent/50"
    >
      <ColorSwatch
        color={draft.color}
        label={t("databaseOptions.color")}
        disabled={locked}
        onChange={onColor}
      />
      <CardTitleInput
        value={draft.name}
        label={t("databaseOptions.name")}
        className="h-7 bg-transparent text-[13px] ring-0 hover:ring-1 focus:bg-background focus:ring-2"
        onCommit={onName}
      />
      {status && (
        <AmbySelect
          value={draft.group}
          disabled={locked}
          size="sm"
          variant="bare"
          aria-label={t("databaseOptions.group")}
          className="w-[5.5rem] shrink-0 text-[11px] text-muted-foreground"
          options={STATUS_GROUPS.map((group) => ({
            value: group,
            label: t(`databaseOptions.group_${group}`),
          }))}
          onValueChange={(group) => onGroup(group as StatusGroup)}
        />
      )}
      <button
        type="button"
        disabled={locked}
        aria-label={t("databaseOptions.remove")}
        title={t("databaseOptions.remove")}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/option:opacity-100 disabled:opacity-0"
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </button>
    </ReorderableRow>
  )
}

interface InstantOptionsEditorProps {
  property: DatabasePropertySummary
  disabled?: boolean
  /** Saves the whole list and resolves once the property shows it. */
  onSave: (drafts: OptionDraft[]) => Promise<void>
}

/** The options of a property, each change saved at once (no Save button to forget). */
function InstantOptionsEditor({ property, disabled, onSave }: InstantOptionsEditorProps) {
  const { t } = useTranslation()
  const status = property.propertyType === "status"
  const drafts = React.useMemo(() => draftsFromProperty(property), [property])
  // The order while a row is being dragged; it settles on the saved list afterwards.
  const [order, setOrder] = React.useState(drafts)
  React.useEffect(() => setOrder(drafts), [drafts])
  const orderRef = React.useRef(order)
  orderRef.current = order
  const [newName, setNewName] = React.useState("")
  const [problem, setProblem] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const save = async (next: OptionDraft[]) => {
    const found = findDraftProblem(next)
    if (found) {
      const message = t(`databaseOptions.${found.problem}`)
      setProblem(message)
      throw new Error(message)
    }
    setProblem(null)
    setBusy(true)
    try {
      await onSave(next)
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure))
      setOrder(drafts)
      throw failure
    } finally {
      setBusy(false)
    }
  }
  const update = (index: number, patch: Partial<OptionDraft>) =>
    save(drafts.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)))
  const changed = (next: OptionDraft[]) => void save(next).catch(() => {})
  const moveBy = (index: number, offset: -1 | 1) => {
    const next = [...orderRef.current]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setOrder(next)
    changed(next)
  }
  const dropped = () => {
    const current = orderRef.current
    if (current.map((draft) => draft.key).join() !== drafts.map((draft) => draft.key).join()) {
      changed(current)
    }
  }
  const add = () => {
    const name = newName.trim()
    if (!name) return
    void save([
      ...drafts,
      { key: newDraftKey(), id: null, name, color: nextOptionColor(drafts), group: "notStarted" },
    ])
      .then(() => setNewName(""))
      .catch(() => {})
  }
  const locked = disabled || busy

  return (
    <div className="space-y-2">
      {order.length > 0 && (
        <Reorder.Group
          axis="y"
          values={order}
          onReorder={setOrder}
          className="space-y-0.5 rounded-xl border border-border/70 bg-muted/20 p-1"
        >
          {order.map((draft, index) => (
            <OptionRow
              key={draft.key}
              draft={draft}
              status={status}
              locked={Boolean(locked)}
              onName={(name) => update(index, { name })}
              onColor={(color) =>
                changed(drafts.map((d, i) => (i === index ? { ...d, color } : d)))
              }
              onGroup={(group) =>
                changed(drafts.map((d, i) => (i === index ? { ...d, group } : d)))
              }
              onRemove={() => changed(drafts.filter((_, position) => position !== index))}
              onMove={(offset) => moveBy(index, offset)}
              onDropped={dropped}
            />
          ))}
        </Reorder.Group>
      )}
      {order.length === 0 && (
        <p className="rounded-xl border border-dashed border-border/70 px-3 py-3 text-center text-xs text-muted-foreground">
          {t("databaseOptions.empty")}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Plus
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={newName}
            disabled={locked}
            maxLength={80}
            aria-label={t("databaseOptions.newOption")}
            placeholder={t("databaseOptions.newOption")}
            className="h-8 w-full rounded-lg border border-dashed border-input bg-transparent pl-7 pr-2 text-[13px] outline-none placeholder:text-muted-foreground hover:border-foreground/30 focus:border-solid focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              add()
            }}
          />
        </div>
        <button
          type="button"
          disabled={locked || !newName.trim()}
          aria-label={t("databaseOptions.add")}
          title={t("databaseOptions.add")}
          className={cn(
            "flex h-8 shrink-0 items-center rounded-lg border border-input px-2.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
          )}
          onClick={add}
        >
          {t("databaseOptions.addShort")}
        </button>
      </div>
      {problem && (
        <p role="alert" className="text-xs leading-snug text-destructive">
          {problem}
        </p>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("databaseOptions.removeHint")}
      </p>
    </div>
  )
}

interface PropertyConfigEditorProps {
  property: DatabasePropertySummary
  disabled?: boolean
  /** The database that owns the property, its sibling databases, and its title. */
  database?: DatabaseSummary
  databases: DatabaseSummary[]
  databaseTitle: string
  /** Saves a settings change; rejects with the reason, which is shown here. */
  onUpdateConfig: (propertyId: string, patch: PropertyConfigPatch) => Promise<void>
  onSaveOptions: (propertyId: string, drafts: OptionDraft[]) => Promise<unknown>
  onSaveRelation: (property: DatabasePropertySummary, config: RelationConfigState) => Promise<void>
  onSaveRollup: (property: DatabasePropertySummary, draft: RollupDraft) => Promise<void>
  className?: string
}

/**
 * Everything that can be set on one property, by type, in one place: the options of a
 * Select, Multi-select or Status; the format of a Number; the date and time format of a
 * Date; the expression of a Formula; the target, limit and reverse of a Relation; the
 * relation, field and function of a Rollup. Simple settings are saved as soon as they are
 * changed; a Relation and a Rollup are applied with one button, since they are chosen together.
 */
export function PropertyConfigEditor({
  property,
  disabled,
  database,
  databases,
  databaseTitle,
  onUpdateConfig,
  onSaveOptions,
  onSaveRelation,
  onSaveRollup,
  className,
}: PropertyConfigEditorProps) {
  const { t, i18n } = useTranslation()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const config = configOf(property)
  const locked = disabled || busy

  const run = async (change: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await change()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  const patch = (next: PropertyConfigPatch) => run(() => onUpdateConfig(property.propertyId, next))
  const currentDatabaseId = database?.databaseId ?? ""

  let body: React.ReactNode = null
  if (isOptionProperty(property.propertyType)) {
    body = (
      <SettingField label={t("databaseProperty.options")}>
        <InstantOptionsEditor
          property={property}
          disabled={disabled}
          onSave={async (drafts) => {
            await onSaveOptions(property.propertyId, drafts)
          }}
        />
      </SettingField>
    )
  } else if (property.propertyType === "number") {
    const format = (config.format as string) || "number"
    const currency = typeof config.currency === "string" ? config.currency : ""
    body = (
      <>
        <SettingField label={t("databaseProperty.numberFormat")}>
          <Segmented
            label={t("databaseProperty.numberFormat")}
            value={format as "number" | "percent" | "currency"}
            disabled={locked}
            options={(["number", "percent", "currency"] as const).map((id) => ({
              id,
              label: t(`databaseProperty.numberFormats.${id}`),
            }))}
            onChange={(next) =>
              void patch({
                numberFormat: next,
                ...(next === "currency" ? { currency: currency || "USD" } : {}),
              })
            }
          />
        </SettingField>
        {format === "currency" && (
          <SettingField label={t("databaseProperty.currency")}>
            <CardTitleInput
              value={currency}
              label={t("databaseProperty.currency")}
              className="h-8 flex-none text-[13px] uppercase"
              onCommit={(code) => patch({ currency: code })}
            />
          </SettingField>
        )}
      </>
    )
  } else if (property.propertyType === "date") {
    const display = dateDisplayOf(property.configJson)
    const example = formatDateValue(
      new Date().toISOString(),
      { ...display, includeTime: display.includeTime },
      i18n.language,
    )
    body = (
      <>
        <SettingField label={t("databaseProperty.dateFormat")} hint={example}>
          <AmbySelect
            value={display.dateFormat}
            disabled={locked}
            aria-label={t("databaseProperty.dateFormat")}
            options={DATE_FORMAT_IDS.map((id) => ({
              value: id,
              label: t(`databaseProperty.dateFormats.${id}`),
            }))}
            onValueChange={(dateFormat) =>
              void patch({ dateFormat: dateFormat as (typeof DATE_FORMAT_IDS)[number] })
            }
          />
        </SettingField>
        <SettingToggle
          label={t("databaseProperty.includeTime")}
          hint={t("databaseProperty.includeTimeHint")}
          checked={display.includeTime}
          disabled={locked}
          onChange={(includeTime) => void patch({ includeTime })}
        />
        {display.includeTime && (
          <SettingField label={t("databaseProperty.timeFormat")}>
            <Segmented
              label={t("databaseProperty.timeFormat")}
              value={display.timeFormat}
              disabled={locked}
              options={(["24h", "12h"] as const).map((id) => ({
                id,
                label: t(`databaseProperty.timeFormats.${id}`),
              }))}
              onChange={(timeFormat) => void patch({ timeFormat })}
            />
          </SettingField>
        )}
      </>
    )
  } else if (property.propertyType === "formula") {
    const expression = typeof config.expression === "string" ? config.expression : ""
    body = (
      <SettingField
        label={t("databaseProperty.formula")}
        hint={t("databaseWorkspace.formulaExpressionHint")}
      >
        <CardTitleInput
          value={expression}
          label={t("databaseProperty.formula")}
          className="h-8 flex-none font-mono text-xs"
          onCommit={(next) => patch({ formulaExpression: next })}
        />
      </SettingField>
    )
  } else if (property.propertyType === "relation") {
    body = (
      <LinkedRelationSettings
        property={property}
        disabled={disabled}
        databases={databases}
        currentDatabaseId={currentDatabaseId}
        currentDatabaseTitle={databaseTitle}
        onSave={onSaveRelation}
      />
    )
  } else if (property.propertyType === "rollup") {
    body = (
      <RollupSettings
        property={property}
        disabled={disabled}
        database={database}
        databases={databases}
        currentDatabaseId={currentDatabaseId}
        onSave={onSaveRollup}
      />
    )
  }

  if (!body) return null
  return (
    <div className={cn("space-y-3.5 text-[13px]", className)}>
      {body}
      {error && (
        <p role="alert" className="text-xs leading-snug text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
