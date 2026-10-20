import { useTranslation } from "react-i18next"

function Numbers({ items }: { items: { label: string; value: number }[] }) {
  return (
    <dl className="mt-2 flex flex-wrap gap-x-7 gap-y-2">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="text-xl font-bold tabular-nums leading-tight">
            {item.value.toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The numbers under the workshop's name: worlds, stories, words written. */
export function WorkshopNumbers({
  worlds,
  stories,
  words,
}: {
  worlds: number
  stories: number
  words: number
}) {
  const { t } = useTranslation()
  return (
    <Numbers
      items={[
        { label: t("creative.workshopPage.worlds"), value: worlds },
        { label: t("creative.workshopPage.stories"), value: stories },
        { label: t("creative.workshopPage.words"), value: words },
      ]}
    />
  )
}

/** The numbers under the name of a universe or of the standalone stories: stories, words written. */
export function ScopeNumbers({ stories, words }: { stories: number; words: number }) {
  const { t } = useTranslation()
  return (
    <Numbers
      items={[
        { label: t("creative.workshopPage.stories"), value: stories },
        { label: t("creative.workshopPage.words"), value: words },
      ]}
    />
  )
}
