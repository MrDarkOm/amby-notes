import * as React from "react"
import { Calculator, Link2, Sigma } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import { AmbySelect } from "@/components/ui/amby-select"
import { SettingInlineRow } from "./property-settings-ui"
import {
  aggregationsFor,
  isDraftComplete,
  nextDraft,
  relationPropertiesOf,
  relationTargetDatabaseId,
  rollupDraftOf,
  targetPropertiesFor,
  type RollupDraft,
} from "./rollup-model"

interface RollupSettingsProps {
  property: DatabasePropertySummary
  disabled?: boolean
  database: DatabaseSummary | undefined
  databases: DatabaseSummary[]
  currentDatabaseId: string
  onSave: (property: DatabasePropertySummary, draft: RollupDraft) => Promise<void>
}

/**
 * The relation, the field and the function of a Rollup as three lists, each offering only what
 * the earlier choices allow. The change is applied once all three are chosen.
 */
export function RollupSettings({
  property,
  disabled,
  database,
  databases,
  currentDatabaseId,
  onSave,
}: RollupSettingsProps) {
  const { t } = useTranslation()
  const saved = React.useMemo(() => rollupDraftOf(property.configJson), [property.configJson])
  const [draft, setDraft] = React.useState(saved)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => setDraft(saved), [saved])

  const context = { database, databases, currentDatabaseId, ownPropertyId: property.propertyId }
  const relations = relationPropertiesOf(database)
  const relation = relations.find((candidate) => candidate.propertyId === draft.relationId)
  const targets = targetPropertiesFor(relation, databases, currentDatabaseId, property.propertyId)
  const target = targets.find((candidate) => candidate.propertyId === draft.targetId)
  const targetDatabase = databases.find(
    (candidate) => candidate.databaseId === relationTargetDatabaseId(relation, currentDatabaseId),
  )
  const locked = disabled || busy

  const choose = async (change: Partial<RollupDraft>) => {
    const next = nextDraft(draft, change, context)
    setDraft(next)
    const changed =
      next.relationId !== saved.relationId ||
      next.targetId !== saved.targetId ||
      next.aggregation !== saved.aggregation
    if (!isDraftComplete(next) || !changed) return
    setBusy(true)
    setError(null)
    try {
      await onSave(property, next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setDraft(saved)
    } finally {
      setBusy(false)
    }
  }

  if (relations.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{t("databaseRollup.noRelation")}</p>
  }
  const pick = { value: "", label: t("databaseRollup.pick") }

  return (
    <div className="space-y-1">
      <SettingInlineRow icon={<Link2 />} label={t("databaseRollup.relation")}>
        <AmbySelect
          value={draft.relationId}
          disabled={locked}
          aria-label={t("databaseRollup.relation")}
          options={[
            pick,
            ...relations.map((candidate) => ({
              value: candidate.propertyId,
              label: candidate.name,
            })),
          ]}
          onValueChange={(relationId) => void choose({ relationId })}
        />
      </SettingInlineRow>
      <SettingInlineRow icon={<Sigma />} label={t("databaseRollup.target")}>
        <AmbySelect
          value={draft.targetId}
          disabled={locked || !relation || targets.length === 0}
          aria-label={t("databaseRollup.target")}
          options={[
            pick,
            ...targets.map((candidate) => ({
              value: candidate.propertyId,
              label: candidate.name,
            })),
          ]}
          onValueChange={(targetId) => void choose({ targetId })}
        />
      </SettingInlineRow>
      <SettingInlineRow icon={<Calculator />} label={t("databaseRollup.aggregation")}>
        <AmbySelect
          value={draft.aggregation}
          disabled={locked || !target}
          aria-label={t("databaseRollup.aggregation")}
          options={[
            pick,
            ...(target
              ? aggregationsFor(target.propertyType).map((aggregation) => ({
                  value: aggregation,
                  label: t(`databaseRollup.agg.${aggregation}`),
                }))
              : []),
          ]}
          onValueChange={(aggregation) => void choose({ aggregation })}
        />
      </SettingInlineRow>
      {relation && targets.length === 0 && (
        <p className="px-1 pt-1 text-[11px] text-muted-foreground">
          {t("databaseRollup.noTargets")}
        </p>
      )}
      {isDraftComplete(draft) && target && (
        <p className="px-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {t("databaseRollup.summary", {
            aggregation: t(`databaseRollup.agg.${draft.aggregation}`),
            field: target.name,
            database: targetDatabase?.title ?? "",
          })}
        </p>
      )}
      {error && (
        <p role="alert" className="px-1 pt-1 text-xs leading-snug text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
