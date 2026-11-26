import type { DatabasePropertySummary } from "@/lib/storage"

export function DossierTemplateDialog(_props: {
  open: boolean
  databaseId: string
  expectedGeneration: number
  properties: DatabasePropertySummary[]
  knownHints: ReadonlyMap<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  return null
}
