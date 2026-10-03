import { AmbySelect } from "@/components/ui/amby-select"
import * as React from "react"
import { Plus, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabasePropertySummary } from "@/lib/storage"
import {
  filterableKeys,
  filterKind,
  isCompleteCondition,
  newCondition,
  operandInput,
  operatorsFor,
  withOperator,
} from "./filter-editor-model"
import { fieldKey, TITLE_KEY, type ViewCondition } from "./view-config"

const CONTROL =
  "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"

interface Row {
  id: number
  condition: ViewCondition
}

export interface ViewFilterEditorProps {
  /** Saved conditions, when the saved filter is a plain AND of conditions. */
  conditions: ViewCondition[]
  /** The saved filter has structure this editor cannot show (OR, nested groups). */
  complex: boolean
  properties: DatabasePropertySummary[]
  titleName: string
  disabled?: boolean
  /** A column the user asked to filter from its header: starts a new row. */
  requestedField?: string | null
  onRequestedFieldHandled?: () => void
  /** Only complete conditions are sent; unfinished rows stay in this editor. */
  onChange: (conditions: ViewCondition[]) => void
  onResetComplex: () => void
}

function signature(conditions: ViewCondition[]): string {
  return JSON.stringify(
    conditions.map((condition) => [
      fieldKey(condition.field),
      condition.operator,
      condition.operand,
    ]),
  )
}

/**
 * Typed filter rows: column, condition and a value editor that matches the
 * column (options for Select/Status, a date picker, a number field, yes/no).
 * A row with a missing value is a draft and does not filter yet.
 */
export function ViewFilterEditor({
  conditions,
  complex,
  properties,
  titleName,
  disabled = false,
  requestedField = null,
  onRequestedFieldHandled,
  onChange,
  onResetComplex,
}: ViewFilterEditorProps) {
  const { t } = useTranslation()
  const types = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const property of properties) map[property.propertyId] = property.propertyType
    return map
  }, [properties])
  const columns = React.useMemo(
    () => [{ key: TITLE_KEY, name: titleName, type: "text" }, ...filterableKeys(properties)],
    [properties, titleName],
  )
  const nextId = React.useRef(0)
  const makeRows = React.useCallback(
    (list: ViewCondition[]): Row[] =>
      list.map((condition) => ({ id: nextId.current++, condition })),
    [],
  )
  const [rows, setRows] = React.useState<Row[]>(() => makeRows(conditions))
  // Compare only complete conditions: an unfinished saved condition is shown as a
  // draft row and must not look like an outside change on every render.
  const savedSignature = signature(
    conditions.filter((condition) => isCompleteCondition(condition, types)),
  )

  // Follow changes made elsewhere (another window, a reload) without dropping drafts.
  React.useEffect(() => {
    setRows((current) => {
      const complete = current.filter((row) => isCompleteCondition(row.condition, types))
      if (signature(complete.map((row) => row.condition)) === savedSignature) return current
      return [
        ...makeRows(conditions.filter((condition) => isCompleteCondition(condition, types))),
        ...current.filter((row) => !isCompleteCondition(row.condition, types)),
      ]
    })
    // `conditions` is represented by its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSignature, types, makeRows])

  const commit = React.useCallback(
    (next: Row[]) => {
      setRows(next)
      const complete = next
        .map((row) => row.condition)
        .filter((condition) => isCompleteCondition(condition, types))
      if (signature(complete) !== savedSignature) onChange(complete)
    },
    [onChange, savedSignature, types],
  )

  React.useEffect(() => {
    if (!requestedField) return
    setRows((current) => [
      ...current,
      { id: nextId.current++, condition: newCondition(requestedField, types) },
    ])
    onRequestedFieldHandled?.()
  }, [requestedField, types, onRequestedFieldHandled])

  const operatorLabel = (kind: string, operator: string) => t(operatorKey(kind, operator))

  if (complex) {
    return (
      <div className="space-y-3 p-1">
        <p className="text-xs text-muted-foreground">{t("databaseFilter.complexNotice")}</p>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onResetComplex}>
          {t("databaseFilter.complexClear")}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">{t("databaseFilter.empty")}</p>
      )}
      {rows.map((row, index) => {
        const key = fieldKey(row.condition.field) ?? TITLE_KEY
        const kind = filterKind(key, types) ?? "text"
        const input = operandInput(kind, row.condition.operator)
        const complete = isCompleteCondition(row.condition, types)
        const property = properties.find((candidate) => candidate.propertyId === key)
        const setCondition = (condition: ViewCondition) =>
          commit(
            rows.map((candidate) =>
              candidate.id === row.id ? { ...candidate, condition } : candidate,
            ),
          )
        return (
          <div key={row.id} className="space-y-1 rounded-md border border-border/60 p-1.5">
            <div className="flex items-center gap-1.5">
              <AmbySelect
                size="sm"
                className="flex-1"
                aria-label={t("databaseFilter.field")}
                value={key}
                disabled={disabled}
                options={columns.map((column) => ({ value: column.key, label: column.name }))}
                onValueChange={(next) => setCondition(newCondition(next, types))}
              />
              <AmbySelect
                size="sm"
                className="flex-1"
                aria-label={t("databaseFilter.operator")}
                value={row.condition.operator}
                disabled={disabled}
                options={operatorsFor(kind).map((operator) => ({
                  value: operator,
                  label: operatorLabel(kind, operator),
                }))}
                onValueChange={(next) => setCondition(withOperator(row.condition, next, types))}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={t("databaseFilter.remove")}
                title={t("databaseFilter.remove")}
                onClick={() => commit(rows.filter((candidate) => candidate.id !== row.id))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            {input !== "none" && (
              <OperandEditor
                input={input}
                property={property}
                value={row.condition.operand}
                disabled={disabled}
                onChange={(operand) => setCondition({ ...row.condition, operand })}
              />
            )}
            {!complete && (
              <p className="px-0.5 text-[11px] text-muted-foreground">
                {t("databaseFilter.incomplete")}
              </p>
            )}
            <span className="sr-only">{index + 1}</span>
          </div>
        )
      })}
      <div className="flex items-center justify-between pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-xs"
          disabled={disabled}
          onClick={() =>
            setRows((current) => [
              ...current,
              { id: nextId.current++, condition: newCondition(TITLE_KEY, types) },
            ])
          }
        >
          <Plus className="size-3.5" />
          {t("databaseFilter.add")}
        </Button>
        {rows.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            disabled={disabled}
            onClick={() => commit([])}
          >
            {t("databaseFilter.clear")}
          </Button>
        )}
      </div>
    </div>
  )
}

function operatorKey(kind: string, operator: string): string {
  if (kind === "date" && operator in DATE_WORDS) return `databaseFilter.opDate.${operator}`
  if (
    (kind === "select" || kind === "status" || kind === "multiSelect") &&
    operator === "contains"
  ) {
    return "databaseFilter.opOption.contains"
  }
  return `databaseFilter.op.${operator}`
}

const DATE_WORDS: Record<string, true> = {
  equals: true,
  notEquals: true,
  greaterThan: true,
  greaterOrEqual: true,
  lessThan: true,
  lessOrEqual: true,
}

function OperandEditor({
  input,
  property,
  value,
  disabled,
  onChange,
}: {
  input: "text" | "number" | "date" | "boolean" | "option"
  property?: DatabasePropertySummary
  value: unknown
  disabled: boolean
  onChange: (operand: unknown) => void
}) {
  const { t } = useTranslation()
  const label = t("databaseFilter.value")
  if (input === "boolean") {
    return (
      <AmbySelect
        size="sm"
        className="w-full"
        aria-label={label}
        value={value === false ? "no" : "yes"}
        disabled={disabled}
        options={[
          { value: "yes", label: t("databaseFilter.yes") },
          { value: "no", label: t("databaseFilter.no") },
        ]}
        onValueChange={(next) => onChange(next === "yes")}
      />
    )
  }
  if (input === "option") {
    return (
      <AmbySelect
        size="sm"
        className="w-full"
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        options={[
          { value: "", label: t("databaseFilter.pickOption") },
          ...(property?.options ?? []).map((option) => ({
            value: option.optionId,
            label: option.name,
          })),
        ]}
        onValueChange={(next) => onChange(next || undefined)}
      />
    )
  }
  return (
    <input
      className={`${CONTROL} w-full`}
      aria-label={label}
      type={input === "date" ? "date" : "text"}
      inputMode={input === "number" ? "decimal" : undefined}
      value={typeof value === "string" ? value : ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
    />
  )
}
