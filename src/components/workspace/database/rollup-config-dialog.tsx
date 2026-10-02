import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  configureDatabaseRollup,
  type DatabasePropertySummary,
  type DatabaseSummary,
} from "@/lib/storage"
import { RollupWizard } from "./rollup-wizard"
import { EMPTY_ROLLUP_DRAFT, isDraftComplete, type RollupDraft } from "./rollup-model"

function draftOf(property: DatabasePropertySummary | null): RollupDraft {
  if (!property) return EMPTY_ROLLUP_DRAFT
  try {
    const config = JSON.parse(property.configJson) as Record<string, unknown>
    return {
      relationId: typeof config.relationPropertyId === "string" ? config.relationPropertyId : "",
      targetId: typeof config.targetPropertyId === "string" ? config.targetPropertyId : "",
      aggregation: typeof config.aggregation === "string" ? config.aggregation : "",
    }
  } catch {
    return EMPTY_ROLLUP_DRAFT
  }
}

interface RollupConfigDialogProps {
  /** The rollup being edited; `null` closes the dialog. */
  property: DatabasePropertySummary | null
  database: DatabaseSummary | undefined
  databases: DatabaseSummary[]
  vaultGeneration: number | null
  onClose: () => void
  /** After a successful save, so the owner can reload the schema and values. */
  onSaved: () => void | Promise<void>
}

/** Changes the relation, field and function of an existing Rollup. */
export function RollupConfigDialog({
  property,
  database,
  databases,
  vaultGeneration,
  onClose,
  onSaved,
}: RollupConfigDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState<RollupDraft>(EMPTY_ROLLUP_DRAFT)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const propertyId = property?.propertyId ?? null

  React.useEffect(() => {
    setDraft(draftOf(property))
    setError(null)
    // The dialog restarts from the stored configuration whenever another rollup opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId])

  async function save() {
    if (!property || !database || vaultGeneration === null || !isDraftComplete(draft)) return
    setBusy(true)
    setError(null)
    try {
      await configureDatabaseRollup({
        expectedGeneration: vaultGeneration,
        databaseId: database.databaseId,
        propertyId: property.propertyId,
        expectedManifestRevision: database.manifestRevision,
        relationPropertyId: draft.relationId,
        targetPropertyId: draft.targetId,
        aggregation: draft.aggregation,
      })
      await onSaved()
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={property !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("databaseRollup.configureTitle")}</DialogTitle>
          <DialogDescription>{property?.name}</DialogDescription>
        </DialogHeader>
        <RollupWizard
          draft={draft}
          onChange={setDraft}
          database={database}
          databases={databases}
          currentDatabaseId={database?.databaseId ?? ""}
          ownPropertyId={property?.propertyId}
          disabled={busy}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !isDraftComplete(draft)} onClick={() => void save()}>
            {t("databaseRollup.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
