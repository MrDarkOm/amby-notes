import { ArrowDown, ArrowUp, EyeOff } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { DeskSpan } from "./desk-layout-model"

interface DeskControlsProps {
  name: string
  span: DeskSpan
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onWidth: () => void
  onHide: () => void
}

const BUTTON =
  "flex h-8 min-w-8 items-center justify-center rounded-lg border border-border bg-background px-2 text-[13px] font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"

/** What a widget shows in the layout mode: earlier, later, width (third, two thirds, row), hide. */
export function DeskControls({
  name,
  span,
  first,
  last,
  onUp,
  onDown,
  onWidth,
  onHide,
}: DeskControlsProps) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-1">
      <button
        type="button"
        disabled={first}
        aria-label={t("creative.desk.moveUp", { name })}
        title={t("creative.desk.moveUp", { name })}
        onClick={onUp}
        className={BUTTON}
      >
        <ArrowUp className="size-4" />
      </button>
      <button
        type="button"
        disabled={last}
        aria-label={t("creative.desk.moveDown", { name })}
        title={t("creative.desk.moveDown", { name })}
        onClick={onDown}
        className={BUTTON}
      >
        <ArrowDown className="size-4" />
      </button>
      <button
        type="button"
        aria-label={t("creative.desk.width", {
          name,
          width: t(`creative.desk.widthName.${span}`),
        })}
        title={t("creative.desk.width", { name, width: t(`creative.desk.widthName.${span}`) })}
        onClick={onWidth}
        className={BUTTON}
      >
        {t(`creative.desk.widthMark.${span}`)}
      </button>
      <button
        type="button"
        aria-label={t("creative.desk.hide", { name })}
        title={t("creative.desk.hide", { name })}
        onClick={onHide}
        className={BUTTON}
      >
        <EyeOff className="size-4" />
      </button>
    </div>
  )
}
