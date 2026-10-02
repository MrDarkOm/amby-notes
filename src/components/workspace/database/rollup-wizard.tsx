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

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"

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
        <select
          className={SELECT}
          value={draft.relationId}
          disabled={disabled}
          onChange={(event) =>
            onChange(nextDraft(draft, { relationId: event.target.value }, context))
          }
        >
          <option value="">{t("databaseRollup.pick")}</option>
          {relations.map((property) => (
            <option key={property.propertyId} value={property.propertyId}>
              {property.name}
            </option>
          ))}
        </select>
      </label>
      {relation && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t("databaseRollup.target")}</span>
          <select
            className={SELECT}
            value={draft.targetId}
            disabled={disabled || targets.length === 0}
            onChange={(event) =>
              onChange(nextDraft(draft, { targetId: event.target.value }, context))
            }
          >
            <option value="">{t("databaseRollup.pick")}</option>
            {targets.map((property) => (
              <option key={property.propertyId} value={property.propertyId}>
                {property.name}
              </option>
            ))}
          </select>
          {targets.length === 0 && (
            <span className="block pt-1">{t("databaseRollup.noTargets")}</span>
          )}
        </label>
      )}
      {target && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t("databaseRollup.aggregation")}</span>
          <select
            className={SELECT}
            value={draft.aggregation}
            disabled={disabled}
            onChange={(event) =>
              onChange(nextDraft(draft, { aggregation: event.target.value }, context))
            }
          >
            <option value="">{t("databaseRollup.pick")}</option>
            {aggregationsFor(target.propertyType).map((aggregation) => (
              <option key={aggregation} value={aggregation}>
                {t(`databaseRollup.agg.${aggregation}`)}
              </option>
            ))}
          </select>
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
