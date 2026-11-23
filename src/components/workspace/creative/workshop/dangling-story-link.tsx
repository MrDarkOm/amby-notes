import * as React from "react"
import { useTranslation } from "react-i18next"
import { updateDatabaseRelationValue, type DatabaseRow, type WorkshopSummary } from "@/lib/storage"
import { reportOperationError } from "@/lib/operation-errors"
import { NoticeLine } from "@/components/workspace/notices/notice-line"
import { useDatabaseStore } from "../../database/database-store"
import { relationTargetsOf } from "./workshop-model"

interface DanglingStoryLinkProps {
  workshop?: WorkshopSummary | null
  databaseId: string
  row?: DatabaseRow
  locked?: boolean
}

export function DanglingStoryLink({ workshop, databaseId, row, locked }: DanglingStoryLinkProps) {
  const propertyId = workshop?.sections.find(
    (section) => section.databaseId === databaseId && section.state !== "missing",
  )?.storiesPropertyId
  if (!workshop || !row || !propertyId) return null
  const targets = relationTargetsOf(row.valuesJson, propertyId)
  if (targets.length === 0) return null
  const cardIds = new Set(workshop.stories.map((story) => story.cardNoteId))
  const retained = targets.filter((id) => cardIds.has(id))
  if (retained.length === targets.length) return null
  return (
    <DanglingStoryAction
      key={row.rowRevision}
      databaseId={databaseId}
      propertyId={propertyId}
      row={row}
      retained={retained}
      locked={Boolean(locked || workshop.readOnly)}
    />
  )
}

function DanglingStoryAction({
  databaseId,
  propertyId,
  row,
  retained,
  locked,
}: {
  databaseId: string
  propertyId: string
  row: DatabaseRow
  retained: string[]
  locked: boolean
}) {
  const { t } = useTranslation()
  const generation = useDatabaseStore((state) => state.vaultGeneration)
  const [pending, setPending] = React.useState(false)
  const [completed, setCompleted] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const remove = async () => {
    if (generation === null || pending || locked) return
    setPending(true)
    setError(null)
    try {
      await updateDatabaseRelationValue({
        expectedGeneration: generation,
        operationId: `story-link-${crypto.randomUUID()}`,
        databaseId,
        noteId: row.noteId,
        propertyId,
        targetNoteIds: retained,
        expectedRevision: row.rowRevision,
      })
      setCompleted(true)
      useDatabaseStore.getState().invalidateHosts()
    } catch (error) {
      setError(reportOperationError(error))
    } finally {
      setPending(false)
    }
  }

  if (completed) return null
  return (
    <div className="flex flex-col gap-1 px-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>{t("creative.danglingStory.deleted")}</span>
        {!locked && generation !== null && (
          <button
            type="button"
            disabled={pending}
            onClick={() => void remove()}
            className="rounded underline hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("creative.danglingStory.remove")}
          </button>
        )}
      </div>
      {error && <NoticeLine text={error} />}
    </div>
  )
}
