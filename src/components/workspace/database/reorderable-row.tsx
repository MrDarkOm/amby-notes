import * as React from "react"
import { Reorder, useDragControls, type HTMLMotionProps } from "motion/react"
import { GripVertical } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

interface ReorderableRowProps<T> {
  /** The item this row stands for; the same object stays in the `Reorder.Group` values. */
  value: T
  disabled?: boolean
  /** Moves the row one place with the arrow keys on the grip. */
  onMove: (offset: -1 | 1) => void
  /** The row was let go after dragging. */
  onDropped?: () => void
  className?: string
  children: React.ReactNode
  /** Extra motion settings such as entrance and exit animations. */
  motionProps?: Pick<HTMLMotionProps<"li">, "initial" | "animate" | "exit" | "transition">
}

/**
 * A row of a list that is reordered by its grip: press and drag it, or focus the grip and
 * press the up and down arrow keys. Meant to sit inside a `Reorder.Group`.
 */
export function ReorderableRow<T>({
  value,
  disabled,
  onMove,
  onDropped,
  className,
  children,
  motionProps,
}: ReorderableRowProps<T>) {
  const { t } = useTranslation()
  const controls = useDragControls()
  return (
    <Reorder.Item
      {...motionProps}
      value={value}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDropped}
      whileDrag={{ scale: 1.02 }}
      className={cn("relative flex items-center gap-1.5", className)}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label={t("databaseOptions.drag")}
        title={t("databaseOptions.drag")}
        style={{ touchAction: "none" }}
        className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
        onPointerDown={(event) => {
          if (disabled) return
          event.preventDefault()
          controls.start(event)
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
          event.preventDefault()
          event.stopPropagation()
          onMove(event.key === "ArrowUp" ? -1 : 1)
        }}
      >
        <GripVertical className="size-3.5" />
      </button>
      {children}
    </Reorder.Item>
  )
}
