import * as React from "react"
import { Reorder } from "motion/react"
import { AmbySelect } from "@/components/ui/amby-select"
import { ChevronRight, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import type {
  DatabasePropertySummary,
  DatabaseSummary,
  UpdateDatabasePropertyConfigRequest,
} from "@/lib/storage"
import { cn } from "@/lib/utils"
import { CardTitleInput } from "./layouts/card-title-input"
import { OptionMenuTrigger } from "./option-edit-menu"
import { StatusBadge } from "./property-value"
import { safeOptionColor } from "./value-format"
import {
  STATUS_GROUPS,
  applyDraftPatch,
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
  /** Saves a change made in the option's menu; rejects with the reason. */
  onChange: (patch: Partial<OptionDraft>) => Promise<void>
  onRemove: () => void
  /** Moves the row one place with the keyboard. */
  onMove: (offset: -1 | 1) => void
  /** The row was dropped after dragging. */
  onDropped: () => void
}

/** One option: a grip to drag it and its label; pressing it opens the option's own menu. */
function OptionRow({
  draft,
  status,
  locked,
  onChange,
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
      className="group/option rounded-lg px-1 py-0.5 hover:bg-accent/50"
    >
      <OptionMenuTrigger
        draft={draft}
        status={status}
        onChange={onChange}
        onRemove={onRemove}
        trigger={
          <button
            type="button"
            disabled={locked}
            aria-label={`${t("databaseOptions.moreActions")}: ${draft.name}`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 pr-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
          >
            <StatusBadge
              chip={{
                key: draft.key,
                kind: "option",
                label: draft.name,
                color: safeOptionColor(draft.color),
              }}
            />
            {draft.isDefault && (
              <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("databaseOptions.defaultBadge")}
              </span>
            )}
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground",
                draft.isDefault ? "" : "ml-auto",
              )}
            />
          </button>
        }
      />
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
    save(
      applyDraftPatch(
        drafts,
        drafts[index]?.key ?? "",
        patch,
        property.propertyType === "multiSelect",
      ),
    )
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
      {
        key: newDraftKey(),
        id: null,
        name,
        color: nextOptionColor(drafts),
        group: "notStarted",
        isDefault: false,
      },
    ])
      .then(() => setNewName(""))
      .catch(() => {})
  }
  // A Status is shown by stage: each stage has its own rows, its own "+", and rows are dragged
  // within their stage. Whatever changes, the saved list is kept stage by stage.
  const [addingGroup, setAddingGroup] = React.useState<StatusGroup | null>(null)
  const [groupName, setGroupName] = React.useState("")
  const byGroup = (list: OptionDraft[], group: StatusGroup, replacement?: OptionDraft[]) =>
    STATUS_GROUPS.flatMap((candidate) =>
      candidate === group && replacement ? replacement : list.filter((d) => d.group === candidate),
    )
  const addToGroup = (group: StatusGroup) => {
    const name = groupName.trim()
    if (!name) {
      setAddingGroup(null)
      return
    }
    void save(
      byGroup(
        [
          ...drafts,
          {
            key: newDraftKey(),
            id: null,
            name,
            color: nextOptionColor(drafts),
            group,
            isDefault: false,
          },
        ],
        group,
      ),
    )
      .then(() => {
        setGroupName("")
        setAddingGroup(null)
      })
      .catch(() => {})
  }
  const moveInGroup = (group: StatusGroup, draft: OptionDraft, offset: -1 | 1) => {
    const items = orderRef.current.filter((d) => d.group === group)
    const index = items.indexOf(draft)
    const target = index + offset
    if (index === -1 || target < 0 || target >= items.length) return
    ;[items[index], items[target]] = [items[target], items[index]]
    const next = byGroup(orderRef.current, group, items)
    setOrder(next)
    changed(next)
  }
  const locked = disabled || busy

  if (status) {
    return (
      <div className="space-y-1">
        {STATUS_GROUPS.map((group) => {
          const items = order.filter((d) => d.group === group)
          return (
            <section key={group} aria-label={t(`databaseOptions.group_${group}`)}>
              <div className="flex items-center justify-between px-1 pt-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t(`databaseOptions.group_${group}`)}
                </span>
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`${t("databaseOptions.add")}: ${t(`databaseOptions.group_${group}`)}`}
                  title={t("databaseOptions.add")}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
                  onClick={() => {
                    setGroupName("")
                    setAddingGroup(group)
                  }}
                >
                  <Plus className="size-4" />
                </button>
              </div>
              {items.length > 0 && (
                <Reorder.Group
                  axis="y"
                  values={items}
                  onReorder={(next) => setOrder(byGroup(orderRef.current, group, next))}
                  className="space-y-0.5"
                >
                  {items.map((draft) => (
                    <OptionRow
                      key={draft.key}
                      draft={draft}
                      status
                      locked={Boolean(locked)}
                      onChange={(patch) => save(applyDraftPatch(drafts, draft.key, patch, false))}
                      onRemove={() => changed(drafts.filter((d) => d.key !== draft.key))}
                      onMove={(offset) => moveInGroup(group, draft, offset)}
                      onDropped={dropped}
                    />
                  ))}
                </Reorder.Group>
              )}
              {addingGroup === group && (
                <input
                  autoFocus
                  value={groupName}
                  maxLength={80}
                  aria-label={t("databaseOptions.newOption")}
                  placeholder={t("databaseOptions.newOption")}
                  className="mt-0.5 h-8 w-full rounded-lg border border-input bg-transparent px-2 text-[13px] outline-none focus:border-ring"
                  onChange={(event) => setGroupName(event.target.value)}
                  onBlur={() => addToGroup(group)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addToGroup(group)
                    }
                    if (event.key === "Escape") {
                      event.preventDefault()
                      setGroupName("")
                      setAddingGroup(null)
                    }
                  }}
                />
              )}
            </section>
          )
        })}
        {problem && (
          <p role="alert" className="text-xs leading-snug text-destructive">
            {problem}
          </p>
        )}
        <p className="pt-1 text-[11px] leading-snug text-muted-foreground">
          {t("databaseOptions.removeHint")}
        </p>
      </div>
    )
  }

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
              onChange={(patch) => update(index, patch)}
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
            className="amby-inset-icon-input h-8 w-full rounded-lg border border-dashed border-input bg-transparent pl-7 pr-2 text-[13px] outline-none placeholder:text-muted-foreground hover:border-foreground/30 focus:border-solid focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
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
            "flex h-8 shrink-0 items-center rounded-lg border border-input px-2.5 text-xs outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40",
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
