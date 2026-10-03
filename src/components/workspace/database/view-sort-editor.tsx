import { AmbySelect } from "@/components/ui/amby-select"
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { DatabasePropertySummary } from "@/lib/storage"
import { isSortable } from "./filter-editor-model"
import { fieldKey, fieldRefFromKey, TITLE_KEY, type ViewSort } from "./view-config"

export interface ViewSortEditorProps {
  sorts: ViewSort[]
  properties: DatabasePropertySummary[]
  titleName: string
  disabled?: boolean
  onChange: (sorts: ViewSort[]) => void
}

/** An ordered list of sort rules: the first decides, later ones break ties. */
export function ViewSortEditor({
  sorts,
  properties,
  titleName,
  disabled = false,
  onChange,
}: ViewSortEditorProps) {
  const { t } = useTranslation()
  const types: Record<string, string> = {}
  for (const property of properties) types[property.propertyId] = property.propertyType
  const columns = [
    { key: TITLE_KEY, name: titleName },
    ...properties
      .filter((property) => isSortable(property.propertyId, types))
      .map((property) => ({ key: property.propertyId, name: property.name })),
  ]
  const used = new Set(sorts.map((sort) => fieldKey(sort.field)))
  const free = columns.find((column) => !used.has(column.key))
  const replace = (index: number, sort: ViewSort) =>
    onChange(sorts.map((candidate, at) => (at === index ? sort : candidate)))
  const move = (index: number, by: -1 | 1) => {
    const next = [...sorts]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item)
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {sorts.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">{t("databaseSort.empty")}</p>
      )}
      {sorts.map((sort, index) => {
        const key = fieldKey(sort.field) ?? TITLE_KEY
        return (
          <div key={`${key}-${index}`} className="flex items-center gap-1.5">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">
              {index === 0 ? t("databaseSort.first") : t("databaseSort.then")}
            </span>
            <AmbySelect
              size="sm"
              className="flex-1"
              value={key}
              disabled={disabled}
              aria-label={t("databaseFilter.field")}
              options={columns
                .filter((column) => column.key === key || !used.has(column.key))
                .map((column) => ({ value: column.key, label: column.name }))}
              onValueChange={(next) => replace(index, { ...sort, field: fieldRefFromKey(next) })}
            />
            <AmbySelect
              size="sm"
              className="w-28"
              value={sort.direction}
              disabled={disabled}
              aria-label={t("databaseSort.title")}
              options={[
                { value: "asc", label: t("databaseSort.ascending") },
                { value: "desc", label: t("databaseSort.descending") },
              ]}
              onValueChange={(next) =>
                replace(index, { ...sort, direction: next === "desc" ? "desc" : "asc" })
              }
            />
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || index === 0}
              aria-label={t("databaseSort.moveUp")}
              title={t("databaseSort.moveUp")}
              onClick={() => move(index, -1)}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || index === sorts.length - 1}
              aria-label={t("databaseSort.moveDown")}
              title={t("databaseSort.moveDown")}
              onClick={() => move(index, 1)}
            >
              <ArrowDown className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={t("databaseSort.remove")}
              title={t("databaseSort.remove")}
              onClick={() => onChange(sorts.filter((_, at) => at !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )
      })}
      <div className="flex items-center justify-between pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-xs"
          disabled={disabled || !free}
          onClick={() =>
            free &&
            onChange([
              ...sorts,
              { field: fieldRefFromKey(free.key), direction: "asc", nulls: "last" },
            ])
          }
        >
          <Plus className="size-3.5" />
          {t("databaseSort.add")}
        </Button>
        {sorts.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            {t("databaseSort.clear")}
          </Button>
        )}
      </div>
    </div>
  )
}
