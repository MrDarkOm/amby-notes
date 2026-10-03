import * as React from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { IconValue } from "@/components/workspace/icon-value"
import { EmojiPickerPanel } from "@/components/workspace/tiptap/EmojiPickerPanel"
import { cn } from "@/lib/utils"

/** Rough size of the picker, to keep it inside the window. */
const PICKER_WIDTH = 360
const PICKER_HEIGHT = 440
const MARGIN = 8

interface IconPickerButtonProps {
  value?: string
  /** Shown while no icon is chosen. */
  fallback: React.ReactNode
  /** Accessible name of the button, for example "Change icon". */
  label: string
  /** An empty string means the default icon. */
  onChange: (icon: string) => void
  disabled?: boolean
  className?: string
  iconClassName?: string
}

/**
 * An icon that opens the emoji and icon picker when pressed. The picker is shown
 * in a portal at the window level, so panels and cards that clip their content
 * (or open the record on click) do not cut it or react to clicks inside it.
 */
export function IconPickerButton({
  value,
  fallback,
  label,
  onChange,
  disabled,
  className,
  iconClassName,
}: IconPickerButtonProps) {
  const { t } = useTranslation()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null)

  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - PICKER_WIDTH - MARGIN))
    const below = rect.bottom + 4
    const top =
      below + PICKER_HEIGHT <= window.innerHeight
        ? below
        : Math.max(MARGIN, rect.top - PICKER_HEIGHT - 4)
    setPosition({ left, top })
  }
  const close = () => setPosition(null)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-expanded={position !== null}
        data-no-drag=""
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
          className,
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          if (position) close()
          else open()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <IconValue value={value} fallback={fallback} className={iconClassName} />
      </button>
      {position &&
        createPortal(
          <div
            className="fixed z-[300]"
            style={{ left: position.left, top: position.top }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Escape") close()
            }}
          >
            <EmojiPickerPanel
              triggerRef={triggerRef}
              onSelect={(next) => {
                onChange(next.native)
                close()
              }}
              onClear={() => {
                onChange("")
                close()
              }}
              clearLabel={t("tree.resetIcon")}
              onClose={close}
            />
          </div>,
          document.body,
        )}
    </>
  )
}
