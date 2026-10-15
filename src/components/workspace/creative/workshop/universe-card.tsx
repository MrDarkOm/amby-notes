import { Globe2, Library, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ScopeCard } from "./scope-card"
import type { UniverseItem } from "./workshop-model"

/** The list's own first item: what no universe holds. It is never a universe's ID. */
const STANDALONE = "standalone"

interface UniverseCardProps {
  universes: UniverseItem[]
  /** The universe chosen, or `null` for the standalone stories. */
  selectedUniverseId: string | null
  onSelectUniverse: (universeId: string | null) => void
  /** Starts making a universe; `null` when the workshop cannot be written to. */
  onNewUniverse: (() => void) | null
  /** Opens the page of the chosen universe, or the workshop's for the standalone stories. */
  onOpenTarget: () => void
}

/**
 * The card of the universes at the foot of the panel, below "Create": it sets the scope the stories
 * and the world above are shown in. Its first item is always "Standalone stories" (not a universe,
 * and the default), then the universes of the base, then "New universe".
 */
export function UniverseCard({
  universes,
  selectedUniverseId,
  onSelectUniverse,
  onNewUniverse,
  onOpenTarget,
}: UniverseCardProps) {
  const { t } = useTranslation()
  const selected = selectedUniverseId
    ? (universes.find((universe) => universe.noteId === selectedUniverseId) ?? null)
    : null
  const untitled = t("creative.workshop.untitled")

  const options = [
    { value: STANDALONE, label: t("creative.workshop.standalone") },
    ...universes.map((universe) => ({
      value: universe.noteId,
      label: universe.title || untitled,
    })),
  ]

  return (
    <ScopeCard
      label={t("creative.workshop.universesLabel")}
      ariaLabel={t("creative.workshop.chooseUniverse")}
      icon={selected ? <Globe2 /> : <Library />}
      name={selected ? selected.title || untitled : t("creative.workshop.standalone")}
      meta={null}
      value={selected ? selected.noteId : STANDALONE}
      options={options}
      onValueChange={(value) => onSelectUniverse(value === STANDALONE ? null : value)}
      action={
        onNewUniverse
          ? {
              label: t("creative.panel.newUniverse"),
              icon: <Plus className="size-4" />,
              onSelect: onNewUniverse,
            }
          : undefined
      }
      openLabel={
        selected ? t("creative.workshop.openUniverse") : t("creative.workshop.openWorkshop")
      }
      onOpen={onOpenTarget}
    />
  )
}
