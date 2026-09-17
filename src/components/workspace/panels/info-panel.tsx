"use client"

import * as React from "react"
import {
  CalendarDays,
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  Folder,
  GripVertical,
  Hash,
  Link2,
  List,
  Paperclip,
  Plus,
  Tags,
  Trash2,
  Type,
  Waypoints,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion, Reorder, useDragControls } from "motion/react"

import { cn } from "@/lib/utils"
import { motionTransitions } from "@/lib/motion-config"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  applyDatabaseValueBatch,
  deleteDatabaseProperty,
  getDatabaseNoteContext,
  listDatabases,
  renameDatabaseProperty,
  reorderDatabaseProperties,
  type CustomProperty,
  type DatabaseNoteContext,
  type DatabasePropertySummary,
  type FrontmatterProperty,
} from "@/lib/storage"
import { IconValue } from "../icon-value"
import { noteEditingPolicy } from "../editor/note-editing-policy"
import { PropertyEditor } from "./property-editor"
import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import type { PanelRenderProps } from "../panel-registry"
import { DatabaseCell } from "../database/database-cell"
import { useDatabaseStore } from "../database/database-store"
import { movePropertyId } from "../database/property-order"
import { PropertyHeaderMenu } from "../database/table-view"
import { databasePropertyIconKey } from "../database/property-icon"
import { useViewStateStore } from "../use-view-state-store"
import { PanelHeader } from "./panel-header"

function databasePropertyIcon(property: DatabasePropertySummary) {
  return property.propertyType === "number"
    ? Hash
    : property.propertyType === "checkbox"
      ? CheckSquare
      : property.propertyType === "date"
        ? CalendarDays
        : property.propertyType === "url"
          ? Link2
          : property.propertyType === "select"
            ? List
            : property.propertyType === "multiSelect" || property.propertyType === "status"
              ? Tags
              : property.propertyType === "files"
                ? Paperclip
                : property.propertyType === "relation"
                  ? Waypoints
                  : Type
}

function PropertyDragIcon({
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

function useMotionPropertyOrder(
  sourceIds: string[],
  onCommit: (propertyIds: string[]) => Promise<void>,
) {
  const sourceKey = sourceIds.join("\u0000")
  const [order, setOrder] = React.useState(sourceIds)
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const orderRef = React.useRef(sourceIds)
  const draggingRef = React.useRef<string | null>(null)
  const startOrderRef = React.useRef(sourceIds)

  React.useEffect(() => {
    if (draggingRef.current) return
    orderRef.current = sourceIds
    setOrder(sourceIds)
    // sourceKey intentionally represents the complete incoming order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  const commitOrder = React.useCallback(
    async (next: string[], previous: string[]) => {
      try {
        await onCommit(next)
      } catch {
        orderRef.current = previous
        setOrder(previous)
      }
    },
    [onCommit],
  )

  const reorder = React.useCallback((next: string[]) => {
    orderRef.current = next
    setOrder(next)
  }, [])

  const startDrag = React.useCallback((propertyId: string) => {
    draggingRef.current = propertyId
    startOrderRef.current = [...orderRef.current]
    setDraggingId(propertyId)
  }, [])

  const endDrag = React.useCallback(() => {
    const previous = startOrderRef.current
    const next = orderRef.current
    draggingRef.current = null
    setDraggingId(null)
    if (previous.join("\u0000") !== next.join("\u0000")) {
      void commitOrder(next, previous)
    }
  }, [commitOrder])

  const moveWithKeyboard = React.useCallback(
    (propertyId: string, direction: -1 | 1) => {
      const previous = orderRef.current
      const index = previous.indexOf(propertyId)
      const targetIndex = index + direction
      if (index < 0 || targetIndex < 0 || targetIndex >= previous.length) return
      const next = movePropertyId(
        previous,
        propertyId,
        previous[targetIndex],
        direction < 0 ? "before" : "after",
      )
      orderRef.current = next
      setOrder(next)
      void commitOrder(next, previous)
    },
    [commitOrder],
  )

  return { order, draggingId, reorder, startDrag, endDrag, moveWithKeyboard }
}

function DatabasePropertyRow({
  property,
  context,
  pending,
  error,
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
      <div className="group/property flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent/60 focus-within:bg-accent/60">
        <PropertyDragIcon
          icon={
            <IconValue
              value={iconValue}
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
          iconValue={iconValue}
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
          onCommit={onCommit}
        />
      </div>
    </Reorder.Item>
  )
}

function DatabaseSchemaRow({
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
      <div className="group/property flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent/60 focus-within:bg-accent/60">
        <PropertyDragIcon
          icon={
            <IconValue
              value={iconValue}
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
          iconValue={iconValue}
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

function PropertyValueTextarea({
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

function PropertyRow({
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
  const [value, setValue] = React.useState(property.value)
  React.useEffect(() => setValue(property.value), [property.value])
  const options = property.settings
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)

  async function saveValue(next = value) {
    if (next === property.value) return
    await onValueSave({ ...property, value: next })
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
      <div className="group/property flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent/60 focus-within:bg-accent/60">
        <PropertyDragIcon
          icon={
            <IconValue
              value={property.icon}
              fallback={property.propertyType === "checkbox" ? "☑️" : "◆"}
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
          <select
            value={value}
            disabled={disabled}
            className="h-7 w-full min-w-0 rounded-md border-0 bg-transparent px-1 text-xs text-foreground outline-none focus:bg-accent/40"
            onChange={(event) => {
              setValue(event.target.value)
              void saveValue(event.target.value)
            }}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
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
            className="h-7 w-full min-w-0 rounded-md bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:bg-accent/40"
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

function frontmatterPropertyIcon(property: FrontmatterProperty, propertyType?: string) {
  if (propertyType === "checkbox") return CheckSquare
  if (propertyType === "number") return Hash
  if (propertyType === "date") return CalendarDays
  if (propertyType === "select") return List
  if (propertyType === "url") return Link2
  if (propertyType === "text") {
    const key = property.key.trim().toLowerCase()
    if (key === "tags" || key === "tag" || key === "keywords") return Tags
    return Type
  }

  const key = property.key.trim().toLowerCase()
  if (key === "tags" || key === "tag" || key === "keywords") return Tags
  if (
    key === "date" ||
    key === "due" ||
    key === "created" ||
    key === "modified" ||
    key === "deadline"
  ) {
    return CalendarDays
  }
  if (
    property.valueKind === "checkbox" ||
    property.value === "true" ||
    property.value === "false"
  ) {
    return CheckSquare
  }
  if (property.valueKind === "number") return Hash
  if (property.valueKind === "list") return List
  if (
    property.valueKind === "url" ||
    property.value.startsWith("http://") ||
    property.value.startsWith("https://")
  ) {
    return Link2
  }
  return Type
}

function parseYamlList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean)
  }
  const lines = trimmed.split("\n")
  const items: string[] = []
  let hasDash = false
  for (const line of lines) {
    const itemMatch = /^\s*-\s*(.+)$/u.exec(line)
    if (itemMatch) {
      hasDash = true
      items.push(itemMatch[1].trim().replace(/^['"]|['"]$/gu, ""))
    } else if (line.trim()) {
      items.push(line.trim().replace(/^['"]|['"]$/gu, ""))
    }
  }
  if (!hasDash && items.length === 1 && items[0].includes(",")) {
    return items[0]
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean)
  }
  return items.filter(Boolean)
}

function FrontmatterPropertyValue({
  property,
  propertyType,
  settings = "",
  onSave,
  disabled,
}: {
  property: FrontmatterProperty
  propertyType?: string
  settings?: string
  onSave?: (value: string) => Promise<void>
  disabled?: boolean
}) {
  const effectiveType =
    propertyType ||
    (property.valueKind === "checkbox" || property.value === "true" || property.value === "false"
      ? "checkbox"
      : property.valueKind === "number"
        ? "number"
        : property.valueKind === "date"
          ? "date"
          : property.valueKind === "list"
            ? "list"
            : property.valueKind === "url" ||
                property.value.startsWith("http://") ||
                property.value.startsWith("https://")
              ? "url"
              : "text")

  const [value, setValue] = React.useState(property.value)
  const [isEditingList, setIsEditingList] = React.useState(false)
  React.useEffect(() => setValue(property.value), [property.value])

  const options = React.useMemo(() => {
    const list = settings
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean)
    if (value && !list.includes(value)) {
      list.unshift(value)
    }
    return list
  }, [settings, value])

  if (effectiveType === "checkbox") {
    const checked = value === "true"
    return (
      <div className="flex h-7 items-center px-1">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={property.key}
          disabled={disabled}
          onClick={async () => {
            const next = checked ? "false" : "true"
            setValue(next)
            await onSave?.(next)
          }}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded border",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background hover:border-primary/50",
          )}
        >
          {checked && <Check className="size-3" />}
        </button>
      </div>
    )
  }

  if (effectiveType === "select") {
    return (
      <select
        value={value}
        disabled={disabled}
        className="h-7 w-full min-w-0 rounded-md border-0 bg-transparent px-1 text-xs text-foreground outline-none focus:bg-accent/40"
        onChange={(event) => {
          const next = event.target.value
          setValue(next)
          void onSave?.(next)
        }}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }

  if (effectiveType === "number") {
    return (
      <input
        type="number"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== property.value) void onSave?.(value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setValue(property.value)
            event.currentTarget.blur()
          }
        }}
        className="h-7 w-full min-w-0 rounded-md bg-transparent px-1 font-mono text-xs tabular-nums text-foreground outline-none focus:bg-accent/40"
      />
    )
  }

  if (effectiveType === "date") {
    return (
      <input
        type="date"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== property.value) void onSave?.(value)
        }}
        className="h-7 w-full min-w-0 rounded-md bg-transparent px-1 text-xs text-foreground outline-none focus:bg-accent/40"
      />
    )
  }

  if (effectiveType === "list" && !isEditingList) {
    const items = parseYamlList(value)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsEditingList(true)}
        className="flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md px-1 py-1 text-left text-xs outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        {items.length > 0 ? (
          items.map((item, index) => (
            <span
              key={`${item}-${index}`}
              className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground"
            >
              {item}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </button>
    )
  }

  return (
    <PropertyValueTextarea
      value={value}
      initialValue={property.value}
      disabled={Boolean(disabled)}
      onChange={setValue}
      onSave={async () => {
        setIsEditingList(false)
        if (value !== property.value) await onSave?.(value)
      }}
      onReset={() => {
        setValue(property.value)
        setIsEditingList(false)
      }}
    />
  )
}

function FrontmatterPropertyRow({
  property,
  iconValue,
  propertyType = "text",
  settings = "",
  onIconChange,
  onRename,
  onChangeType,
  onChangeSettings,
  onSave,
  onDelete,
  disabled,
}: {
  property: FrontmatterProperty
  iconValue?: string
  propertyType?: string
  settings?: string
  onIconChange?: (icon: string) => Promise<void> | void
  onRename?: (name: string) => Promise<void> | void
  onChangeType?: (type: string) => Promise<void> | void
  onChangeSettings?: (settings: string) => Promise<void> | void
  onSave?: (value: string) => Promise<void>
  onDelete?: () => Promise<void>
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const PropertyIcon = frontmatterPropertyIcon(property, propertyType)
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(property.key)
  const [selectedType, setSelectedType] = React.useState(propertyType)
  const [settingsDraft, setSettingsDraft] = React.useState(settings)
  const [isRenaming, setIsRenaming] = React.useState(false)
  const [currentIcon, setCurrentIcon] = React.useState(iconValue)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const iconButtonRef = React.useRef<HTMLButtonElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setCurrentIcon(iconValue)
  }, [iconValue])

  const handleSelectIcon = React.useCallback(
    (newIcon: string) => {
      setCurrentIcon(newIcon)
      setShowEmojiPicker(false)
      void onIconChange?.(newIcon)
    },
    [onIconChange],
  )

  const handleClearIcon = React.useCallback(() => {
    setCurrentIcon("")
    setShowEmojiPicker(false)
    void onIconChange?.("")
  }, [onIconChange])

  React.useEffect(() => {
    if (!popoverOpen) {
      setNameDraft(property.key)
      setSelectedType(propertyType)
      setSettingsDraft(settings)
      setShowEmojiPicker(false)
    } else {
      setSelectedType(propertyType)
      setSettingsDraft(settings)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [popoverOpen, property.key, propertyType, settings])

  const commitRename = React.useCallback(async () => {
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === property.key) {
      setNameDraft(property.key)
      return
    }
    try {
      setIsRenaming(true)
      await onRename?.(trimmed)
    } finally {
      setIsRenaming(false)
    }
  }, [nameDraft, onRename, property.key])

  const handleTypeChange = React.useCallback(
    async (nextType: string) => {
      setSelectedType(nextType)
      await onChangeType?.(nextType)
    },
    [onChangeType],
  )

  const handleSettingsCommit = React.useCallback(async () => {
    if (settingsDraft !== settings) {
      await onChangeSettings?.(settingsDraft)
    }
  }, [onChangeSettings, settings, settingsDraft])

  return (
    <div
      role="listitem"
      className="group/item relative grid min-h-8 grid-cols-[minmax(7rem,42%)_minmax(0,1fr)] items-start gap-1"
    >
      <div className="flex min-h-8 min-w-0 items-start py-0.5">
        <Popover
          open={popoverOpen}
          onOpenChange={(open) => {
            if (!open) {
              if (settingsDraft !== settings) {
                void onChangeSettings?.(settingsDraft)
              }
              void commitRename()
            }
            setPopoverOpen(open)
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              disabled={disabled}
              className={cn(
                "group/property flex h-7 min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none",
                !disabled &&
                  "hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring cursor-pointer",
                popoverOpen && "bg-accent/60",
              )}
              title={property.key}
              aria-label={property.key}
            >
              <div className="flex size-4 shrink-0 items-center justify-center leading-none text-muted-foreground group-hover/property:text-foreground">
                <IconValue
                  value={currentIcon && currentIcon !== "◆" ? currentIcon : undefined}
                  fallback={<PropertyIcon className="size-3.5" aria-hidden="true" />}
                  className="size-3.5"
                />
              </div>
              <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground group-hover/property:text-foreground">
                {property.key}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={4}
            collisionPadding={16}
            className={cn(
              "z-50",
              showEmojiPicker
                ? "w-auto border-0 bg-transparent p-0 shadow-none"
                : "w-64 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg",
            )}
            onKeyDown={(event) => {
              if (event.key === "Escape" && showEmojiPicker) {
                event.stopPropagation()
                event.preventDefault()
                setShowEmojiPicker(false)
              }
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {showEmojiPicker ? (
              <EmojiPickerPanel
                triggerRef={iconButtonRef}
                onSelect={(emoji) => handleSelectIcon(emoji.native)}
                onClear={handleClearIcon}
                clearLabel={t("tree.resetIcon")}
                onClose={() => setShowEmojiPicker(false)}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <button
                    ref={iconButtonRef}
                    type="button"
                    disabled={!onIconChange}
                    onClick={() => setShowEmojiPicker(true)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background hover:bg-accent cursor-pointer disabled:cursor-default"
                    title={t("infoPanel.propertyIcon")}
                    aria-label={t("infoPanel.propertyIcon")}
                  >
                    <IconValue
                      value={currentIcon && currentIcon !== "◆" ? currentIcon : undefined}
                      fallback={<PropertyIcon className="size-4" />}
                      className="size-4"
                    />
                  </button>
                  <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-border bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
                    <input
                      ref={inputRef}
                      value={nameDraft}
                      disabled={isRenaming}
                      aria-label={t("infoPanel.propertyName")}
                      className="min-w-0 flex-1 bg-transparent text-xs font-medium text-foreground outline-none disabled:opacity-60"
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void commitRename().then(() => setPopoverOpen(false))
                        }
                        if (e.key === "Escape") {
                          e.preventDefault()
                          setNameDraft(property.key)
                          setPopoverOpen(false)
                        }
                      }}
                    />
                  </div>
                </div>

                {onChangeType && (
                  <div className="flex items-center justify-between gap-2 px-1">
                    <span className="text-[11px] text-muted-foreground">
                      {t("infoPanel.propertyType")}
                    </span>
                    <select
                      value={selectedType}
                      onChange={(e) => void handleTypeChange(e.target.value)}
                      className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none cursor-pointer"
                    >
                      <option value="text">
                        {t("infoPanel.propertyTypes.text", { defaultValue: "Текст" })}
                      </option>
                      <option value="number">
                        {t("infoPanel.propertyTypes.number", { defaultValue: "Число" })}
                      </option>
                      <option value="checkbox">
                        {t("infoPanel.propertyTypes.checkbox", { defaultValue: "Флажок" })}
                      </option>
                      <option value="date">
                        {t("infoPanel.propertyTypes.date", { defaultValue: "Дата" })}
                      </option>
                      <option value="select">
                        {t("infoPanel.propertyTypes.select", { defaultValue: "Выбор" })}
                      </option>
                      <option value="url">
                        {t("infoPanel.propertyTypes.url", { defaultValue: "Ссылка" })}
                      </option>
                    </select>
                  </div>
                )}

                {selectedType === "select" && (
                  <div className="flex flex-col gap-1 px-1">
                    <span className="text-[11px] text-muted-foreground">
                      {t("infoPanel.propertyOptions")}
                    </span>
                    <input
                      value={settingsDraft}
                      onChange={(e) => setSettingsDraft(e.target.value)}
                      onBlur={() => void handleSettingsCommit()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void handleSettingsCommit()
                        }
                      }}
                      placeholder={t("infoPanel.propertyOptionsHint")}
                      className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                )}

                {onDelete && (
                  <>
                    <div className="my-0.5 h-px bg-border" />
                    <button
                      type="button"
                      onClick={async () => {
                        setPopoverOpen(false)
                        await onDelete()
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 cursor-pointer"
                      title={t("infoPanel.deleteProperty")}
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t("infoPanel.deleteProperty")}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <div className="min-h-8 min-w-0 px-1 py-0.5">
        <FrontmatterPropertyValue
          property={property}
          propertyType={propertyType}
          settings={settings}
          onSave={onSave}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

export function InfoPanel({
  properties,
  databaseProperties,
  onUpsertCustomProperty,
  onDeleteCustomProperty,
  onReorderCustomProperties,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const [aboutOpen, setAboutOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [propertyEditorOpen, setPropertyEditorOpen] = React.useState(false)
  const [editingProperty, setEditingProperty] = React.useState<CustomProperty | null>(null)
  const [noteDatabaseContext, setNoteDatabaseContext] = React.useState<DatabaseNoteContext | null>(
    null,
  )
  const [pendingDatabaseProperties, setPendingDatabaseProperties] = React.useState<Set<string>>(
    new Set(),
  )
  const [databasePropertyErrors, setDatabasePropertyErrors] = React.useState<
    Record<string, string>
  >({})
  const [propertyOrderBusy, setPropertyOrderBusy] = React.useState(false)
  const [customPropertyOrderBusy, setCustomPropertyOrderBusy] = React.useState(false)
  const databaseInvalidationSeq = useDatabaseStore((state) => state.invalidationSeq)
  const vaultGeneration = useDatabaseStore((state) => state.vaultGeneration)
  const setDatabaseCatalog = useDatabaseStore((state) => state.setCatalog)
  const invalidateDatabaseHosts = useDatabaseStore((state) => state.invalidateHosts)
  const iconOverrides = useViewStateStore((state) => state.iconOverrides)
  const setIcon = useViewStateStore((state) => state.setIcon)
  const [databaseSchemaBusy, setDatabaseSchemaBusy] = React.useState(false)
  const customProperties = React.useMemo(
    () =>
      !properties || properties.kind === "folder" || properties.frontmatter.parseError
        ? []
        : (properties.frontmatter.customProperties ?? []),
    [properties],
  )
  const frontmatterProperties = React.useMemo(
    () =>
      !properties || properties.kind === "folder" || properties.frontmatter.parseError
        ? []
        : (properties.frontmatter.properties ?? []).filter((property) => {
            const key = property.key.trim().toLowerCase()
            return key !== "amby-id" && key !== "id"
          }),
    [properties],
  )
  const frontmatterKeySet = React.useMemo(
    () => new Set(frontmatterProperties.map((prop) => prop.key.trim().toLowerCase())),
    [frontmatterProperties],
  )

  React.useEffect(() => {
    let cancelled = false
    if (!properties || properties.kind === "folder") {
      setNoteDatabaseContext(null)
      return
    }
    void getDatabaseNoteContext(properties.id)
      .then((context) => {
        if (!cancelled) setNoteDatabaseContext(context)
      })
      .catch(() => {
        if (!cancelled) setNoteDatabaseContext(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseInvalidationSeq, properties?.id, properties?.kind])

  const commitDatabaseProperty = React.useCallback(
    async (property: DatabasePropertySummary, valueJson?: string) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      setPendingDatabaseProperties((current) => new Set(current).add(property.propertyId))
      setDatabasePropertyErrors((current) => {
        const next = { ...current }
        delete next[property.propertyId]
        return next
      })
      try {
        const result = await applyDatabaseValueBatch({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          operationId:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? `panel-${crypto.randomUUID()}`
              : `panel-${Date.now()}-${property.propertyId}`,
          cells: [
            {
              noteId: context.row.noteId,
              propertyId: property.propertyId,
              valueJson,
              expectedRevision: context.row.rowRevision,
            },
          ],
        })
        const revision =
          result.revisions.find((item) => item.noteId === context.row.noteId)?.revision ??
          context.row.rowRevision
        setNoteDatabaseContext((current) => {
          if (!current || current.databaseId !== context.databaseId) return current
          const values = JSON.parse(current.row.valuesJson) as Record<string, unknown>
          if (valueJson) values[property.propertyId] = JSON.parse(valueJson)
          else delete values[property.propertyId]
          return {
            ...current,
            row: { ...current.row, valuesJson: JSON.stringify(values), rowRevision: revision },
          }
        })
      } catch (error) {
        setDatabasePropertyErrors((current) => ({
          ...current,
          [property.propertyId]: error instanceof Error ? error.message : String(error),
        }))
        const refreshed = await getDatabaseNoteContext(context.row.noteId).catch(() => null)
        if (refreshed) setNoteDatabaseContext(refreshed)
      } finally {
        setPendingDatabaseProperties((current) => {
          const next = new Set(current)
          next.delete(property.propertyId)
          return next
        })
      }
    },
    [noteDatabaseContext],
  )

  const renameNoteDatabaseProperty = React.useCallback(
    async (property: DatabasePropertySummary, name: string) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await renameDatabaseProperty({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          propertyId: property.propertyId,
          expectedManifestRevision: context.manifestRevision,
          name,
        })
        const [refreshed, catalog] = await Promise.all([
          getDatabaseNoteContext(context.row.noteId),
          listDatabases(),
        ])
        setNoteDatabaseContext(refreshed)
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [invalidateDatabaseHosts, noteDatabaseContext, setDatabaseCatalog],
  )

  const deleteNoteDatabaseProperty = React.useCallback(
    async (property: DatabasePropertySummary) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await deleteDatabaseProperty({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          propertyId: property.propertyId,
          expectedManifestRevision: context.manifestRevision,
        })
        const [refreshed, catalog] = await Promise.all([
          getDatabaseNoteContext(context.row.noteId),
          listDatabases(),
        ])
        setNoteDatabaseContext(refreshed)
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [invalidateDatabaseHosts, noteDatabaseContext, setDatabaseCatalog],
  )

  const renameSchemaProperty = React.useCallback(
    async (property: DatabasePropertySummary, name: string) => {
      if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await renameDatabaseProperty({
          expectedGeneration: vaultGeneration,
          databaseId: databaseProperties.id,
          propertyId: property.propertyId,
          expectedManifestRevision: databaseProperties.manifestRevision,
          name,
        })
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [databaseProperties, invalidateDatabaseHosts, setDatabaseCatalog, vaultGeneration],
  )
  const deleteSchemaProperty = React.useCallback(
    async (property: DatabasePropertySummary) => {
      if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
      setDatabaseSchemaBusy(true)
      try {
        await deleteDatabaseProperty({
          expectedGeneration: vaultGeneration,
          databaseId: databaseProperties.id,
          propertyId: property.propertyId,
          expectedManifestRevision: databaseProperties.manifestRevision,
        })
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setDatabaseSchemaBusy(false)
      }
    },
    [databaseProperties, invalidateDatabaseHosts, setDatabaseCatalog, vaultGeneration],
  )
  const persistNoteDatabaseOrder = React.useCallback(
    async (propertyIds: string[]) => {
      const context = noteDatabaseContext
      if (!context || context.locked) return
      const propertyById = new Map(
        context.properties.map((property) => [property.propertyId, property]),
      )
      setPropertyOrderBusy(true)
      try {
        const result = await reorderDatabaseProperties({
          expectedGeneration: context.vaultGeneration,
          databaseId: context.databaseId,
          expectedManifestRevision: context.manifestRevision,
          propertyIds,
        })
        setNoteDatabaseContext((current) =>
          current?.databaseId === context.databaseId
            ? {
                ...current,
                manifestRevision: result.manifestRevision,
                properties: propertyIds.flatMap((id) => {
                  const property = propertyById.get(id)
                  return property ? [property] : []
                }),
              }
            : current,
        )
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } catch (error) {
        const refreshed = await getDatabaseNoteContext(context.row.noteId).catch(() => null)
        if (refreshed) setNoteDatabaseContext(refreshed)
        throw error
      } finally {
        setPropertyOrderBusy(false)
      }
    },
    [invalidateDatabaseHosts, noteDatabaseContext, setDatabaseCatalog],
  )

  const persistDatabaseSchemaOrder = React.useCallback(
    async (propertyIds: string[]) => {
      if (!databaseProperties || vaultGeneration === null || databaseProperties.locked) return
      setPropertyOrderBusy(true)
      try {
        await reorderDatabaseProperties({
          expectedGeneration: vaultGeneration,
          databaseId: databaseProperties.id,
          expectedManifestRevision: databaseProperties.manifestRevision,
          propertyIds,
        })
        const catalog = await listDatabases()
        setDatabaseCatalog(catalog)
        invalidateDatabaseHosts()
      } finally {
        setPropertyOrderBusy(false)
      }
    },
    [databaseProperties, invalidateDatabaseHosts, setDatabaseCatalog, vaultGeneration],
  )

  const persistCustomPropertyOrder = React.useCallback(
    async (propertyIds: string[]) => {
      if (!onReorderCustomProperties) return
      setCustomPropertyOrderBusy(true)
      try {
        await onReorderCustomProperties(propertyIds)
      } finally {
        setCustomPropertyOrderBusy(false)
      }
    },
    [onReorderCustomProperties],
  )

  const noteDatabaseOrder = useMotionPropertyOrder(
    noteDatabaseContext?.properties.map((property) => property.propertyId) ?? [],
    persistNoteDatabaseOrder,
  )
  const databaseSchemaOrder = useMotionPropertyOrder(
    databaseProperties?.properties.map((property) => property.propertyId) ?? [],
    persistDatabaseSchemaOrder,
  )
  const visibleCustomProperties = React.useMemo(
    () =>
      customProperties.filter(
        (property) => !frontmatterKeySet.has(property.name.trim().toLowerCase()),
      ),
    [customProperties, frontmatterKeySet],
  )
  const customOrder = useMotionPropertyOrder(
    visibleCustomProperties.map((property) => property.id),
    persistCustomPropertyOrder,
  )
  const orderedNoteDatabaseProperties = noteDatabaseOrder.order.flatMap((id) => {
    const property = noteDatabaseContext?.properties.find(
      (candidate) => candidate.propertyId === id,
    )
    return property ? [property] : []
  })
  const orderedDatabaseSchemaProperties = databaseSchemaOrder.order.flatMap((id) => {
    const property = databaseProperties?.properties.find((candidate) => candidate.propertyId === id)
    return property ? [property] : []
  })
  const nonDuplicateCustomProperties = customOrder.order.flatMap((id) => {
    const property = visibleCustomProperties.find((candidate) => candidate.id === id)
    return property ? [property] : []
  })
  if (databaseProperties) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader
          title={t("panels.info")}
          actions={
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {databaseProperties.properties.length}
            </span>
          }
        />
        <ScrollArea className="flex-1">
          <div className="space-y-5 px-4 pb-4">
            <section>
              {databaseProperties.properties.length > 0 ? (
                <Reorder.Group
                  as="div"
                  axis="y"
                  values={databaseSchemaOrder.order}
                  onReorder={databaseSchemaOrder.reorder}
                  role="list"
                  className="space-y-0.5"
                >
                  {orderedDatabaseSchemaProperties.map((property, propertyIndex) => (
                    <DatabaseSchemaRow
                      key={property.propertyId}
                      property={property}
                      disabled={
                        Boolean(databaseProperties.locked) ||
                        databaseSchemaBusy ||
                        propertyOrderBusy
                      }
                      onRename={(name) => renameSchemaProperty(property, name)}
                      onDelete={() => deleteSchemaProperty(property)}
                      iconValue={
                        iconOverrides[
                          databasePropertyIconKey(databaseProperties.id, property.propertyId)
                        ]
                      }
                      onIconChange={(icon) =>
                        setIcon(
                          databasePropertyIconKey(databaseProperties.id, property.propertyId),
                          icon,
                        )
                      }
                      dragging={databaseSchemaOrder.draggingId === property.propertyId}
                      onDragStart={() => databaseSchemaOrder.startDrag(property.propertyId)}
                      onDragEnd={databaseSchemaOrder.endDrag}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowUp" && propertyIndex > 0) {
                          event.preventDefault()
                          databaseSchemaOrder.moveWithKeyboard(property.propertyId, -1)
                        }
                        if (
                          event.key === "ArrowDown" &&
                          propertyIndex < orderedDatabaseSchemaProperties.length - 1
                        ) {
                          event.preventDefault()
                          databaseSchemaOrder.moveWithKeyboard(property.propertyId, 1)
                        }
                      }}
                    />
                  ))}
                </Reorder.Group>
              ) : (
                <div className="px-1 py-3 text-xs text-muted-foreground">
                  {t("infoPanel.noCustom")}
                </div>
              )}
            </section>
            <section className="overflow-hidden rounded-lg border border-border bg-background/30">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2.5 text-left"
                aria-expanded={aboutOpen}
                onClick={() => setAboutOpen((open) => !open)}
              >
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("infoPanel.aboutDatabase")}
                </span>
                <motion.span
                  className="flex text-muted-foreground"
                  initial={false}
                  animate={{ rotate: aboutOpen ? 180 : 0 }}
                  transition={motionTransitions.default}
                >
                  <ChevronDown className="size-3.5" />
                </motion.span>
              </button>
              {aboutOpen && (
                <div className="divide-y divide-border border-t border-border text-[10px]">
                  {[
                    [t("infoPanel.type"), t("infoPanel.databaseType")],
                    [t("infoPanel.databaseRows"), String(databaseProperties.rowCount ?? "—")],
                    [t("infoPanel.databaseProperties"), String(databaseProperties.propertyCount)],
                    [t("infoPanel.databaseViews"), String(databaseProperties.viewCount)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-start justify-between gap-3 px-3 py-2">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="min-w-0 max-w-[65%] break-words text-right text-foreground">
                        {value}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-start gap-2 px-3 py-2">
                    <span className="text-muted-foreground">{t("infoPanel.id")}</span>
                    <code className="min-w-0 flex-1 break-all text-right font-mono text-[10px] text-foreground">
                      {databaseProperties.id}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyId(databaseProperties.id)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t("infoPanel.copyId")}
                    >
                      {copied ? (
                        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </div>
    )
  }
  if (!properties) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("infoPanel.noDocument")}
      </div>
    )
  }
  const warningKey =
    properties.kind === "folder" ? null : noteEditingPolicy(properties.frontmatter).warningKey
  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard access can be unavailable in browser previews.
    }
  }

  function openPropertyEditor() {
    setEditingProperty(null)
    setPropertyEditorOpen(true)
  }

  if (properties.kind === "folder") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader
          title={t("panels.info")}
          actions={
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {properties.noteCount}
            </span>
          }
        />
        <ScrollArea className="flex-1">
          <div className="space-y-5 px-4 pb-4">
            <section className="overflow-hidden rounded-lg border border-border bg-background/30">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
                <Folder className="size-4 text-muted-foreground" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("infoPanel.aboutFolder")}
                </span>
              </div>
              <div className="divide-y divide-border text-[10px]">
                {[
                  [t("infoPanel.type"), properties.type],
                  [t("infoPanel.notesCount"), String(properties.noteCount)],
                  [t("infoPanel.foldersCount"), String(properties.folderCount)],
                  [t("infoPanel.path"), properties.path || "—"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span
                      className="min-w-0 max-w-[65%] break-words text-right text-foreground"
                      title={value}
                    >
                      {value}
                    </span>
                  </div>
                ))}
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="text-muted-foreground">{t("infoPanel.id")}</span>
                  <code className="min-w-0 flex-1 break-all text-right font-mono text-[10px] text-foreground">
                    {properties.id}
                  </code>
                </div>
              </div>
            </section>
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t("infoPanel.properties")}
        actions={
          <>
            {!noteDatabaseContext && (
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t("infoPanel.addProperty")}
                disabled={Boolean(properties.frontmatter.parseError)}
                onClick={openPropertyEditor}
              >
                <Plus className="size-3.5" />
              </button>
            )}
            <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {frontmatterProperties.length +
                nonDuplicateCustomProperties.length +
                (noteDatabaseContext?.properties.length ?? 0)}
            </span>
          </>
        }
      />
      <ScrollArea className="flex-1">
        <div className="space-y-5 px-4 pb-4">
          {warningKey && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(warningKey)}
            </p>
          )}
          <section>
            {(noteDatabaseContext?.properties.length ?? 0) +
              nonDuplicateCustomProperties.length +
              frontmatterProperties.length >
            0 ? (
              <div className="space-y-0.5">
                {noteDatabaseContext && orderedNoteDatabaseProperties.length > 0 && (
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={noteDatabaseOrder.order}
                    onReorder={noteDatabaseOrder.reorder}
                    role="list"
                    className="space-y-0.5"
                  >
                    {orderedNoteDatabaseProperties.map((property, propertyIndex) => (
                      <DatabasePropertyRow
                        key={property.propertyId}
                        property={property}
                        context={noteDatabaseContext}
                        pending={pendingDatabaseProperties.size > 0}
                        error={databasePropertyErrors[property.propertyId]}
                        onCommit={(valueJson) => commitDatabaseProperty(property, valueJson)}
                        onRename={(name) => renameNoteDatabaseProperty(property, name)}
                        onDelete={() => deleteNoteDatabaseProperty(property)}
                        iconValue={
                          iconOverrides[
                            databasePropertyIconKey(
                              noteDatabaseContext.databaseId,
                              property.propertyId,
                            )
                          ]
                        }
                        onIconChange={(icon) =>
                          setIcon(
                            databasePropertyIconKey(
                              noteDatabaseContext.databaseId,
                              property.propertyId,
                            ),
                            icon,
                          )
                        }
                        dragging={noteDatabaseOrder.draggingId === property.propertyId}
                        disabled={noteDatabaseContext.locked || propertyOrderBusy}
                        onDragStart={() => noteDatabaseOrder.startDrag(property.propertyId)}
                        onDragEnd={noteDatabaseOrder.endDrag}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && propertyIndex > 0) {
                            event.preventDefault()
                            noteDatabaseOrder.moveWithKeyboard(property.propertyId, -1)
                          }
                          if (
                            event.key === "ArrowDown" &&
                            propertyIndex < orderedNoteDatabaseProperties.length - 1
                          ) {
                            event.preventDefault()
                            noteDatabaseOrder.moveWithKeyboard(property.propertyId, 1)
                          }
                        }}
                      />
                    ))}
                  </Reorder.Group>
                )}
                {frontmatterProperties.length > 0 && (
                  <div role="list" className="space-y-0.5">
                    {frontmatterProperties.map((property) => {
                      const matchedCustom = customProperties.find(
                        (cp) =>
                          cp.name.trim().toLowerCase() === property.key.trim().toLowerCase() ||
                          cp.id === property.key,
                      )
                      const propertyType =
                        matchedCustom?.propertyType ||
                        (property.valueKind === "checkbox"
                          ? "checkbox"
                          : property.valueKind === "number"
                            ? "number"
                            : property.valueKind === "date"
                              ? "date"
                              : property.valueKind === "list"
                                ? "list"
                                : "text")
                      const icon = matchedCustom?.icon

                      return (
                        <FrontmatterPropertyRow
                          key={property.key}
                          property={property}
                          iconValue={icon}
                          propertyType={propertyType}
                          settings={matchedCustom?.settings || ""}
                          onIconChange={async (nextIcon) => {
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: nextIcon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onRename={async (newName) => {
                            if (!newName.trim() || newName.trim() === property.key) return
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: newName.trim(),
                              icon: icon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onChangeType={async (nextType) => {
                            if (nextType === propertyType) return
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType: nextType,
                              value: matchedCustom?.value || property.value,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onChangeSettings={async (nextSettings) => {
                            if (nextSettings === (matchedCustom?.settings || "")) return
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType,
                              value: matchedCustom?.value || property.value,
                              settings: nextSettings,
                            })
                          }}
                          onSave={async (nextVal) => {
                            await onUpsertCustomProperty?.({
                              id: matchedCustom?.id || property.key,
                              name: property.key,
                              icon: icon ?? "",
                              propertyType,
                              value: nextVal,
                              settings: matchedCustom?.settings || "",
                            })
                          }}
                          onDelete={async () => {
                            await onDeleteCustomProperty?.(matchedCustom?.id || property.key)
                          }}
                          disabled={Boolean(properties.frontmatter.parseError)}
                        />
                      )
                    })}
                  </div>
                )}
                {nonDuplicateCustomProperties.length > 0 && (
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={customOrder.order}
                    onReorder={customOrder.reorder}
                    role="list"
                    className="space-y-0.5"
                  >
                    {nonDuplicateCustomProperties.map((property, propertyIndex) => (
                      <PropertyRow
                        key={property.id}
                        property={property}
                        onEdit={() => {
                          setEditingProperty(property)
                          setPropertyEditorOpen(true)
                        }}
                        onValueSave={async (updated) => {
                          await onUpsertCustomProperty?.(updated)
                        }}
                        dragging={customOrder.draggingId === property.id}
                        disabled={customPropertyOrderBusy || !onReorderCustomProperties}
                        onDragStart={() => customOrder.startDrag(property.id)}
                        onDragEnd={customOrder.endDrag}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && propertyIndex > 0) {
                            event.preventDefault()
                            customOrder.moveWithKeyboard(property.id, -1)
                          }
                          if (
                            event.key === "ArrowDown" &&
                            propertyIndex < nonDuplicateCustomProperties.length - 1
                          ) {
                            event.preventDefault()
                            customOrder.moveWithKeyboard(property.id, 1)
                          }
                        }}
                      />
                    ))}
                  </Reorder.Group>
                )}
              </div>
            ) : (
              <div className="space-y-1 px-1 py-3 text-xs text-muted-foreground">
                <div>{t("infoPanel.noCustom")}</div>
                <div className="text-[11px] text-muted-foreground/75">
                  {t("infoPanel.noCustomHint")}
                </div>
              </div>
            )}
          </section>
          {!noteDatabaseContext && (
            <button
              type="button"
              className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={t("infoPanel.addProperty")}
              disabled={Boolean(properties.frontmatter.parseError)}
              onClick={openPropertyEditor}
            >
              <Plus className="size-3.5" />
              {t("infoPanel.addProperty")}
            </button>
          )}
          <section className="overflow-hidden rounded-lg border border-border bg-background/30">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2.5 text-left"
              aria-expanded={aboutOpen}
              onClick={() => setAboutOpen((open) => !open)}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("infoPanel.about")}
              </span>
              <motion.span
                className="flex text-muted-foreground"
                initial={false}
                animate={{ rotate: aboutOpen ? 180 : 0 }}
                transition={motionTransitions.default}
              >
                <ChevronDown className="size-3.5" />
              </motion.span>
            </button>
            {aboutOpen && (
              <div className="divide-y divide-border border-t border-border text-[10px]">
                {[
                  [t("infoPanel.type"), properties.type],
                  [t("infoPanel.created"), properties.created || "—"],
                  [t("infoPanel.modified"), properties.modified || "—"],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="min-w-0 max-w-[65%] break-words text-right text-foreground">
                      {value}
                    </span>
                  </div>
                ))}
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="text-muted-foreground">{t("infoPanel.id")}</span>
                  <code className="min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed text-foreground">
                    {properties.id}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyId(properties.id)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={t("infoPanel.copyId")}
                  >
                    {copied ? (
                      <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                </div>
                {copied && (
                  <div className="px-3 pb-2 text-[10px] text-emerald-600 dark:text-emerald-400">
                    {t("infoPanel.copied")}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
      <PropertyEditor
        property={editingProperty}
        open={propertyEditorOpen}
        onOpenChange={setPropertyEditorOpen}
        onSave={async (property) => {
          if (editingProperty?.name && editingProperty.name !== property.name) {
            await onDeleteCustomProperty?.(editingProperty.name)
          }
          await onUpsertCustomProperty?.(property)
        }}
        onDelete={async (propertyId) => {
          await onDeleteCustomProperty?.(propertyId)
        }}
      />
    </div>
  )
}
