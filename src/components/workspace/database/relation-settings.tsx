import * as React from "react"
import { ArrowLeftRight, Database, Hash } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Switch } from "@/components/ui/switch"
import type { DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import type { RelationConfigState } from "./property-settings"
import { AmbySelect } from "@/components/ui/amby-select"
import { SettingInlineRow } from "./property-settings-ui"
import { usePropertyHasValues } from "./use-property-has-values"

interface Stored {
  targetDatabaseId: string
  maxItems: number | null
  inversePropertyId: string | null
}

function storedOf(property: DatabasePropertySummary, currentDatabaseId: string): Stored {
  let config: { targetDatabaseId?: unknown; maxItems?: unknown; inversePropertyId?: unknown } = {}
  try {
    config = JSON.parse(property.configJson) as typeof config
  } catch {
    // An unreadable configuration starts from the defaults.
  }
  return {
    targetDatabaseId:
      typeof config.targetDatabaseId === "string" ? config.targetDatabaseId : currentDatabaseId,
    maxItems: config.maxItems === 1 ? 1 : null,
    inversePropertyId:
      typeof config.inversePropertyId === "string" && config.inversePropertyId
        ? config.inversePropertyId
        : null,
  }
}

interface RelationSettingsProps {
  property: DatabasePropertySummary
  disabled?: boolean
  /** Records already link pages: the database and the reverse links can no longer change. */
  linked?: boolean
  databases: DatabaseSummary[]
  currentDatabaseId: string
  currentDatabaseTitle: string
  onSave: (property: DatabasePropertySummary, config: RelationConfigState) => Promise<void>
}

/**
 * Which database a Relation points to and how many pages it may link, as two lists, and
 * whether the other database shows the reverse links, as a switch. A choice is applied as soon
 * as it is made, as one checked change of the relation. The reverse property is created with the
 * title of this database; it can be renamed in its own database afterwards.
 */
export function RelationSettings({
  property,
  disabled,
  linked = false,
  databases,
  currentDatabaseId,
  currentDatabaseTitle,
  onSave,
}: RelationSettingsProps) {
  const { t } = useTranslation()
  const stored = React.useMemo(
    () => storedOf(property, currentDatabaseId),
    [currentDatabaseId, property],
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const locked = disabled || busy
  // Links already made cannot be moved to another database or to the other side; the limit can.
  const topologyLocked = locked || linked

  const apply = async (change: Partial<RelationConfigState>) => {
    setBusy(true)
    setError(null)
    try {
      const twoWay = change.twoWay ?? stored.inversePropertyId !== null
      await onSave(property, {
        targetDatabaseId: change.targetDatabaseId ?? stored.targetDatabaseId,
        maxItems: change.maxItems !== undefined ? change.maxItems : stored.maxItems,
        twoWay,
        inversePropertyName: twoWay ? currentDatabaseTitle : "",
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <SettingInlineRow icon={<Database />} label={t("databaseProperty.relationWith")}>
        <AmbySelect
          value={stored.targetDatabaseId}
          disabled={topologyLocked}
          aria-label={t("databaseProperty.relationWith")}
          options={databases.map((database) => ({
            value: database.databaseId,
            label:
              database.databaseId === currentDatabaseId
                ? `${database.title} (${t("databaseProperty.thisDatabase")})`
                : database.title,
          }))}
          onValueChange={(targetDatabaseId) => void apply({ targetDatabaseId })}
        />
      </SettingInlineRow>
      <SettingInlineRow icon={<Hash />} label={t("databaseWorkspace.relationLimit")}>
        <AmbySelect
          value={stored.maxItems === 1 ? "one" : "many"}
          disabled={locked}
          aria-label={t("databaseWorkspace.relationLimit")}
          options={[
            { value: "many", label: t("databaseWorkspace.relationLimitNoLimit") },
            { value: "one", label: t("databaseWorkspace.relationLimitSingle") },
          ]}
          onValueChange={(next) => void apply({ maxItems: next === "one" ? 1 : null })}
        />
      </SettingInlineRow>
      <SettingInlineRow icon={<ArrowLeftRight />} label={t("databaseProperty.relationTwoWay")}>
        <div className="flex justify-end">
          <Switch
            checked={stored.inversePropertyId !== null}
            disabled={topologyLocked}
            aria-label={t("databaseProperty.relationTwoWay")}
            onCheckedChange={(twoWay) => void apply({ twoWay })}
          />
        </div>
      </SettingInlineRow>
      {error && (
        <p role="alert" className="px-1 pt-1 text-xs leading-snug text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** The relation settings, with the lock that follows from the links the records already have. */
export function LinkedRelationSettings(props: Omit<RelationSettingsProps, "linked">) {
  const hasLinks = usePropertyHasValues(
    props.currentDatabaseId,
    props.property.propertyId,
    props.property.configJson,
  )
  return <RelationSettings {...props} linked={hasLinks === true} />
}
