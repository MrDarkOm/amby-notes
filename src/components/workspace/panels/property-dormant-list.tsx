import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  getPropertyPanel,
  propertyStorageStatus,
  purgeDormantProperty,
  restoreDormantProperty,
  type PropertyPanel,
} from "@/lib/properties/property-groups-port"
import { reportOperationError } from "@/lib/operation-errors"

const buttonClass =
  "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"

/**
 * The records of the look whose key is not in the header of the note: grey, below the active
 * properties, with «Вернуть» and «Удалить окончательно» (docs/sync-plan.md, appendix З: З3). The
 * warnings and questions about the properties are cards in the stack of the note, not here.
 */
export function PropertyDormantList({ noteId }: { noteId: string }) {
  const { t } = useTranslation()
  const [panel, setPanel] = React.useState<PropertyPanel | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const status = await propertyStorageStatus()
      setPanel(status?.mode === "groups" ? await getPropertyPanel(noteId) : null)
    } catch {
      setPanel(null)
    }
  }, [noteId])
  React.useEffect(() => {
    void load()
  }, [load])

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      setFailure(null)
    } catch (error) {
      setFailure(reportOperationError(error))
    } finally {
      setBusy(false)
      await load()
    }
  }

  const dormant = panel?.dormant ?? []
  if (dormant.length === 0) return null
  return (
    <section className="space-y-1 text-xs opacity-70">
      <h3 className="font-medium text-foreground">{t("infoPanel.groups.dormantTitle")}</h3>
      <ul className="space-y-1">
        {dormant.map((item) => (
          <li key={item.name} className="flex items-center gap-2">
            <span aria-hidden>{item.icon}</span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void act(() => restoreDormantProperty(noteId, item.name))}
            >
              {t("infoPanel.groups.restore")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void act(() => purgeDormantProperty(noteId, item.name))}
            >
              {t("infoPanel.groups.purge")}
            </button>
          </li>
        ))}
      </ul>
      {failure && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
    </section>
  )
}
