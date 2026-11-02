import { databasePropertyIcon } from "./info-property-icons"
import { AmbySelect } from "@/components/ui/amby-select"
import * as React from "react"
import { Check, GripVertical } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion, Reorder, useDragControls } from "motion/react"
import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import type {
  CustomProperty,
  DatabaseNoteContext,
  DatabasePropertySummary,
  DatabaseSummary,
} from "@/lib/storage"
import { IconValue } from "../icon-value"
import { DatabaseCell } from "../database/database-cell"
import { PropertyHeaderMenu } from "../database/table-view"

export function PropertyDragIcon({
  icon,
  disabled,
  label,
  onKeyDown,
  onPointerDown,
}: {
  icon: React.ReactNode
  disabled: boolean
  label: string
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <motion.span
      className="relative flex size-5 shrink-0 items-center justify-center"
      initial="rest"
      whileHover="active"
    >
      <motion.span
        className="flex items-center justify-center text-muted-foreground"
        variants={{ rest: { opacity: 1 }, active: { opacity: 0 } }}
        transition={motionTransitions.fast}
      >
        {icon}
      </motion.span>
      <motion.button
        type="button"
        disabled={disabled}
        title={label}
        aria-label={label}
        className="absolute inset-0 flex touch-none cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent active:cursor-grabbing disabled:cursor-default"
        variants={{ rest: { opacity: 0 }, active: { opacity: 1 } }}
        whileFocus={{ opacity: 1 }}
        transition={motionTransitions.fast}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <GripVertical className="size-3.5" />
      </motion.button>
    </motion.span>
  )
}

export function DatabasePropertyRow({
  property,
  context,
  pending,
  error,
  databases,
  onOpenNote,
  onCreateRelationRow,
  onCommit,
  onRename,
  onDelete,
  iconValue,
  onIconChange,
  dragging,
  disabled,
  onDragStart,
  onDragEnd,
  onKeyDown,
}: {
  property: DatabasePropertySummary
  context: DatabaseNoteContext
  pending: boolean
  error?: string
  databases: DatabaseSummary[]
  onOpenNote?: (noteId: string) => void
  onCreateRelationRow?: (targetDatabaseId: string, title: string) => Promise<string | void>
  onCommit: (valueJson?: string) => Promise<void>
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  iconValue?: string
  onIconChange: (icon: string) => void
  dragging: boolean
  disabled: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation()
  const PropertyIcon = databasePropertyIcon(property)
  const dragControls = useDragControls()
  const relationTargetId = React.useMemo(() => {
    if (property.propertyType !== "relation") return ""
    try {
      return (
        (JSON.parse(property.configJson) as { targetDatabaseId?: string }).targetDatabaseId ?? ""
      )
    } catch {
      return ""
    }
  }, [property.configJson, property.propertyType])
  return (
    <Reorder.Item
      as="div"
      value={property.propertyId}
      dragListener={false}
      dragControls={dragControls}
      dragElastic={0.06}
      dragMomentum={false}
      layout="position"
      transition={motionTransitions.reorder}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role="listitem"
      data-sortable-property-id={property.propertyId}
      className={cn(
        "relative grid min-h-8 grid-cols-[minmax(7rem,42%)_minmax(0,1fr)] items-start gap-1",
        dragging && "z-10 rounded-md bg-background/95 shadow-sm",
      )}
    >
      <div className="group/property flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent/60 has-[:focus-visible]:bg-accent/60">
        <PropertyDragIcon
          icon={
            <IconValue
              value={iconValue && iconValue !== "◆" ? iconValue : undefined}
              fallback={<PropertyIcon className="size-3.5" aria-hidden="true" />}
              className="size-3.5"
            />
          }
          disabled={disabled}
          label={t("infoPanel.moveDatabaseProperty")}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return
            event.preventDefault()
            dragControls.start(event)
          }}
        />
        <PropertyHeaderMenu
          property={property}
          onRename={onRename}
          onDelete={onDelete}
          iconValue={iconValue === "◆" ? undefined : iconValue}
          onIconChange={onIconChange}
          trigger={
            <button
              type="button"
              disabled={disabled}
              className="min-h-7 min-w-0 flex-1 rounded px-1 py-1 text-left text-xs leading-4 whitespace-normal break-words text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
              title={property.name}
            >
              {property.name}
            </button>
          }
        />
      </div>
      <div className="min-h-8 min-w-0">
        <DatabaseCell
          property={property}
          valuesJson={context.row.valuesJson}
          wrap
          pending={pending}
          error={error}
          compact
          targetDatabaseTitle={
            relationTargetId
              ? databases.find((database) => database.databaseId === relationTargetId)?.title
              : undefined
          }
          onCommit={onCommit}
          onOpenNote={onOpenNote}
          onCreateRelationRow={
            onCreateRelationRow && relationTargetId
              ? (title) => onCreateRelationRow(relationTargetId, title)
              : undefined
          }
        />
      </div>
    </Reorder.Item>
  )
}

export function DatabaseSchemaRow({
  property,
  disabled,
  onRename,
  onDelete,
  iconValue,
  onIconChange,
  dragging,
  onDragStart,
  onDragEnd,
  onKeyDown,
}: {
  property: DatabasePropertySummary
  disabled: boolean
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  iconValue?: string
  onIconChange: (icon: string) => void
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation()
  const PropertyIcon = databasePropertyIcon(property)
  const dragControls = useDragControls()

  return (
    <Reorder.Item
      as="div"
      value={property.propertyId}
      dragListener={false}
      dragControls={dragControls}
      dragElastic={0.06}
      dragMomentum={false}
      layout="position"
      transition={motionTransitions.reorder}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role="listitem"
      data-sortable-property-id={property.propertyId}
      className={cn(
        "relative grid min-h-8 grid-cols-[minmax(7rem,42%)_minmax(0,1fr)] items-start gap-1",
        dragging && "z-10 rounded-md bg-background/95 shadow-sm",
      )}
    >
      <div className="group/property flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent/60 has-[:focus-visible]:bg-accent/60">
        <PropertyDragIcon
          icon={
            <IconValue
              value={iconValue && iconValue !== "◆" ? iconValue : undefined}
              fallback={<PropertyIcon className="size-3.5" aria-hidden="true" />}
              className="size-3.5"
            />
          }
          disabled={disabled}
          label={t("infoPanel.moveDatabaseProperty")}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return
            event.preventDefault()
            dragControls.start(event)
          }}
        />
        <PropertyHeaderMenu
          property={property}
          onRename={onRename}
          onDelete={onDelete}
          iconValue={iconValue === "◆" ? undefined : iconValue}
          onIconChange={onIconChange}
          trigger={
            <button
              type="button"
              disabled={disabled}
              className="min-h-7 min-w-0 flex-1 rounded px-1 py-1 text-left text-xs leading-4 whitespace-normal break-words text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
              title={property.name}
            >
              {property.name}
            </button>
          }
        />
      </div>
      <span className="min-w-0 break-words px-1 py-1 text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
        {t(`databaseWorkspace.propertyTypes.${property.propertyType}`, {
          defaultValue: property.propertyType,
        })}
      </span>
    </Reorder.Item>
  )
}

export function PropertyValueTextarea({
  value,
  initialValue,
  disabled,
  onChange,
  onSave,
  onReset,
}: {
  value: string
  initialValue: string
  disabled: boolean
  onChange: (value: string) => void
  onSave: (value?: string) => Promise<void>
  onReset: () => void
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const resize = React.useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0px"
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [])

  React.useLayoutEffect(() => {
    resize()
  }, [resize, value])

  return (
    <textarea
      ref={textareaRef}
      value={value}
      disabled={disabled}
      rows={1}
      title={initialValue}
      className="min-h-7 w-full min-w-0 resize-none overflow-hidden rounded-md bg-transparent px-1 py-1.5 text-xs leading-4 whitespace-pre-wrap break-words text-foreground outline-none focus:bg-accent/40 disabled:opacity-60"
      placeholder="—"
      onChange={(event) => {
        onChange(event.target.value)
        resize()
      }}
      onBlur={() => void onSave()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Escape") {
          onReset()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function PropertyRow({
  property,
  onEdit,
  onValueSave,
  dragging,
  disabled,
  onDragStart,
  onDragEnd,
  onKeyDown,
}: {
  property: CustomProperty
  onEdit: () => void
  onValueSave: (property: CustomProperty) => Promise<void>
  dragging: boolean
  disabled: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation()
  const dragControls = useDragControls()
  const PropertyIcon = databasePropertyIcon(property)
  const [value, setValue] = React.useState(property.value)
  React.useEffect(() => setValue(property.value), [property.value])
  const options = property.settings
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)

  async function saveValue(next = value) {
    if (next === property.value) return
    try {
      await onValueSave({ ...property, value: next })
    } catch {
      /* The panel displays the write failure. */
    }
  }

  const checked = value === "true"
  const multiline = property.propertyType === "text" || property.propertyType === "url"

  return (
    <Reorder.Item
      as="div"
      value={property.id}
      dragListener={false}
      dragControls={dragControls}
      dragElastic={0.06}
      dragMomentum={false}
      layout="position"
      transition={motionTransitions.reorder}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      role="listitem"
      data-sortable-property-id={property.id}
      className={cn(
        "relative grid min-h-8 grid-cols-[minmax(7rem,42%)_minmax(0,1fr)] items-start gap-1",
        dragging && "z-10 rounded-md bg-background/95 shadow-sm",
      )}
    >
      <div className="group/property flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent/60 has-[:focus-visible]:bg-accent/60">
        <PropertyDragIcon
          icon={
            <IconValue
              value={property.icon && property.icon !== "◆" ? property.icon : undefined}
              fallback={<PropertyIcon className="size-3.5" aria-hidden="true" />}
              className="size-3.5"
            />
          }
          disabled={disabled}
          label={t("infoPanel.moveDatabaseProperty")}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return
            event.preventDefault()
            dragControls.start(event)
          }}
        />
        <button
          type="button"
          disabled={disabled}
          className="min-h-7 min-w-0 flex-1 rounded px-1 py-1 text-left text-xs leading-4 whitespace-normal break-words text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
          title={property.name}
          onClick={onEdit}
        >
          {property.name}
        </button>
      </div>
      <div className="flex min-h-8 min-w-0 items-start px-1 py-0.5">
        {property.propertyType === "checkbox" ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={property.name}
            disabled={disabled}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded border",
              checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:border-primary/60",
            )}
            onClick={() => {
              const next = checked ? "false" : "true"
              setValue(next)
              void saveValue(next)
            }}
          >
            {checked && <Check className="size-3" />}
          </button>
        ) : property.propertyType === "select" ? (
          <AmbySelect
            size="sm"
            variant="bare"
            value={value}
            disabled={disabled}
            aria-label={property.name}
            options={[
              { value: "", label: "—" },
              ...options.map((option) => ({ value: option, label: option })),
            ]}
            onValueChange={(next) => {
              setValue(next)
              void saveValue(next)
            }}
          />
        ) : multiline ? (
          <PropertyValueTextarea
            value={value}
            initialValue={property.value}
            disabled={disabled}
            onChange={setValue}
            onSave={saveValue}
            onReset={() => setValue(property.value)}
          />
        ) : (
          <input
            type={
              property.propertyType === "number"
                ? "number"
                : property.propertyType === "date"
                  ? "date"
                  : property.propertyType === "url"
                    ? "url"
                    : "text"
            }
            value={value}
            disabled={disabled}
            className={cn(
              "h-7 w-full min-w-0 rounded-md bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:bg-accent/40",
              property.propertyType === "number" && "amby-property-number font-mono tabular-nums",
            )}
            placeholder="—"
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void saveValue()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur()
              }
            }}
          />
        )}
      </div>
    </Reorder.Item>
  )
}
