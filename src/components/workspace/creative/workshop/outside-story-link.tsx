import { useTranslation } from "react-i18next"

export function OutsideStoryLink({ count, onShow }: { count: number; onShow: () => void }) {
  const { t } = useTranslation()
  if (count <= 0) return null
  return (
    <button
      type="button"
      onClick={onShow}
      className="w-fit rounded px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {t("creative.workshop.outsideStory", { count })}
    </button>
  )
}
