import { AmbySelect } from "@/components/ui/amby-select"
import { useTranslation } from "react-i18next"
import type { DatabaseSummary } from "@/lib/storage"
import {
  aggregationsFor,
  nextDraft,
  relationPropertiesOf,
  relationTargetDatabaseId,
  targetPropertiesFor,
  isDraftComplete,
  type RollupDraft,
} from "./rollup-model"

interface RollupWizardProps {
  draft: RollupDraft
  onChange: (draft: RollupDraft) => void
  /** The database that owns the rollup. */
  database: DatabaseSummary | undefined
  databases: DatabaseSummary[]
  currentDatabaseId: string
  /** The rollup being edited; it cannot aggregate itself. */
  ownPropertyId?: string
  disabled?: boolean
}

/** Relation → field → function, each step offering only what the previous one allows. */
export function RollupWizard({
  draft,
  onChange,
  database,
  databases,
  currentDatabaseId,
  ownPropertyId,
  disabled = false,
}: RollupWizardProps) {
  const { t } = useTranslation()
  const context = { database, databases, currentDatabaseId, ownPropertyId }
  const relations = relationPropertiesOf(database)
  const relation = relations.find((property) => property.propertyId === draft.relationId)
  const targets = targetPropertiesFor(relation, databases, currentDatabaseId, ownPropertyId)
  const target = targets.find((property) => property.propertyId === draft.targetId)
  const targetDatabase = databases.find(
    (candidate) => candidate.databaseId === relationTargetDatabaseId(relation, currentDatabaseId),
  )

  if (relations.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("databaseRollup.noRelation")}</p>
  }
  return (
    <div className="space-y-3 pt-1">
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>{t("databaseRollup.relation")}</span>
        <AmbySelect
          value={draft.relationId}
          disabled={disabled}
          aria-label={t("databaseRollup.relation")}
          options={[
            { value: "", label: t("databaseRollup.pick") },
            ...relations.map((property) => ({ value: property.propertyId, label: property.name })),
          ]}
          onValueChange={(relationId) => onChange(nextDraft(draft, { relationId }, context))}
        />
      </label>
      {relation && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t("databaseRollup.target")}</span>
          <AmbySelect
            value={draft.targetId}
            disabled={disabled || targets.length === 0}
            aria-label={t("databaseRollup.target")}
            options={[
              { value: "", label: t("databaseRollup.pick") },
              ...targets.map((property) => ({ value: property.propertyId, label: property.name })),
            ]}
            onValueChange={(targetId) => onChange(nextDraft(draft, { targetId }, context))}
          />
          {targets.length === 0 && (
            <span className="block pt-1">{t("databaseRollup.noTargets")}</span>
          )}
        </label>
      )}
      {target && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t("databaseRollup.aggregation")}</span>
          <AmbySelect
            value={draft.aggregation}
            disabled={disabled}
            aria-label={t("databaseRollup.aggregation")}
            options={[
              { value: "", label: t("databaseRollup.pick") },
              ...aggregationsFor(target.propertyType).map((aggregation) => ({
                value: aggregation,
                label: t(`databaseRollup.agg.${aggregation}`),
              })),
            ]}
            onValueChange={(aggregation) => onChange(nextDraft(draft, { aggregation }, context))}
          />
        </label>
      )}
      {isDraftComplete(draft) && target && (
        <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          {t("databaseRollup.summary", {
            aggregation: t(`databaseRollup.agg.${draft.aggregation}`),
            field: target.name,
            database: targetDatabase?.title ?? "",
          })}
        </p>
      )}
    </div>
  )
}
