"use client"

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import data from "@emoji-mart/data"
import { Picker as EmojiMartPicker } from "emoji-mart"
import { ImagePlus, Search, Trash2, Upload, type LucideIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import EMOJI_MART_BASE_STYLES from "@/themes/emoji-mart-base.css?raw"
import { ICON_PICKER_COLORS } from "@/themes/palettes"
import { IconValue } from "@/components/workspace/icon-value"
import { makeIconValue, PICKER_ICONS } from "@/components/workspace/icon-values"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"

interface EmojiData {
  native: string
}

interface Props {
  onSelect: (emoji: EmojiData) => void
  onClose: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
  onClear?: () => void
  clearLabel?: string
  /** Text insertion and Markdown callouts only accept native emoji. */
  emojiOnly?: boolean
}

type PickerTab = "emoji" | "icons" | "upload"
interface CustomEmoji {
  id: string
  name: string
  value: string
}

interface CropDraft {
  image: HTMLImageElement
  url: string
  name: string
}

interface StableEmojiMartPickerProps {
  pickerData: typeof data
  i18n: Record<string, unknown>
  onEmojiSelect: (emoji: EmojiData) => void
  theme: "dark" | "light"
}

type EmojiMartPickerElement = HTMLElement

const CUSTOM_EMOJI_KEY = "amby.customEmoji.v2"
const LEGACY_CUSTOM_EMOJI_KEY = "amby.customEmoji.v1"
const CROP_SIZE = 160
const ICON_GRID_COLUMNS = 8

interface IconGridProps {
  icons: Array<[string, LucideIcon]>
  iconColor: string
  onSelect: (name: string) => void
}

function IconGrid({ icons, iconColor, onSelect }: IconGridProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const rowCount = Math.ceil(icons.length / ICON_GRID_COLUMNS)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 42,
    overscan: 4,
  })

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * ICON_GRID_COLUMNS
          const rowIcons = icons.slice(start, start + ICON_GRID_COLUMNS)
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute inset-x-0 top-0 grid grid-cols-8 gap-1"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {rowIcons.map(([name, Icon]) => (
                <button
                  key={name}
                  type="button"
                  title={name}
                  className="flex aspect-square items-center justify-center rounded-md hover:bg-accent"
                  onClick={() => onSelect(name)}
                >
                  <Icon className="size-5" style={{ color: iconColor }} />
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StableEmojiMartPicker({
  pickerData,
  i18n,
  onEmojiSelect,
  theme,
}: StableEmojiMartPickerProps) {
  const mountRef = React.useRef<HTMLDivElement>(null)
  const onEmojiSelectRef = React.useRef(onEmojiSelect)
  onEmojiSelectRef.current = onEmojiSelect
  const stableOnEmojiSelect = React.useCallback(
    (emoji: EmojiData) => onEmojiSelectRef.current(emoji),
    [],
  )
  const pickerProps = React.useMemo(
    () => ({
      data: pickerData,
      i18n,
      onEmojiSelect: stableOnEmojiSelect,
      theme,
      previewPosition: "none",
      skinTonePosition: "search",
      navPosition: "bottom",
      set: "native",
      dynamicWidth: true,
    }),
    [i18n, pickerData, stableOnEmojiSelect, theme],
  )

  React.useLayoutEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const picker = new EmojiMartPicker(pickerProps) as unknown as EmojiMartPickerElement

    const ensureBundledStyles = () => {
      const currentShadowRoot = picker.shadowRoot
      if (!currentShadowRoot) return
      if (currentShadowRoot.querySelector("style[data-amby-emoji-mart-base]")) return

      const stylesheet = document.createElement("style")
      stylesheet.dataset.ambyEmojiMartBase = "true"
      stylesheet.textContent = EMOJI_MART_BASE_STYLES
      currentShadowRoot.append(stylesheet)
    }

    // Append the picker before installing our stylesheet so the shadow root and
    // emoji-mart's own stylesheet already exist. A persistent MutationObserver
    // caused work during every scroll/update and made the emoji list hitch.
    mount.replaceChildren(picker)
    ensureBundledStyles()
    const frame = requestAnimationFrame(ensureBundledStyles)
    const timer = window.setTimeout(ensureBundledStyles, 50)

    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      mount.replaceChildren()
    }
  }, [pickerProps])

  return <div ref={mountRef} />
}

function readCustomEmoji() {
  if (typeof localStorage === "undefined") return []
  try {
    const stored = localStorage.getItem(CUSTOM_EMOJI_KEY)
    const value = JSON.parse(stored ?? localStorage.getItem(LEGACY_CUSTOM_EMOJI_KEY) ?? "[]")
    if (!Array.isArray(value)) return []
    return value
      .map((item, index): CustomEmoji | null => {
        if (typeof item === "string") {
          return { id: `legacy-${index}`, name: `Emoji ${index + 1}`, value: item }
        }
        if (
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          typeof item.value === "string"
        ) {
          return item as CustomEmoji
        }
        return null
      })
      .filter((item): item is CustomEmoji => item !== null)
      .slice(0, 24)
  } catch {
    return []
  }
}

export function EmojiPickerPanel({
  onSelect,
  onClose,
  triggerRef,
  onClear,
  emojiOnly = false,
}: Props) {
  const ref = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const { resolvedTheme } = useTheme()
  const { t } = useTranslation()
  const [tab, setTab] = React.useState<PickerTab>("emoji")
  const [visitedTabs, setVisitedTabs] = React.useState<Set<PickerTab>>(
    () => new Set<PickerTab>(["emoji"]),
  )
  const [iconColor, setIconColor] = React.useState<string>(ICON_PICKER_COLORS[0])
  const [iconFilter, setIconFilter] = React.useState("")
  const [colorOpen, setColorOpen] = React.useState(false)
  const [customEmoji, setCustomEmoji] = React.useState<CustomEmoji[]>(readCustomEmoji)
  const [dragging, setDragging] = React.useState(false)
  const [cropDraft, setCropDraft] = React.useState<CropDraft | null>(null)
  const [cropZoom, setCropZoom] = React.useState(1)
  const [cropOffset, setCropOffset] = React.useState({ x: 0, y: 0 })
  const cropUrlRef = React.useRef<string | null>(null)
  const cropDragRef = React.useRef<{
    x: number
    y: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const emojiI18n = React.useMemo(
    () => ({
      search: t("emojiPicker.filter"),
      search_no_results_1: t("emojiPicker.noResultsTitle"),
      search_no_results_2: t("emojiPicker.noResults"),
      pick: t("emojiPicker.pick"),
      add_custom: t("emojiPicker.custom"),
      categories: {
        activity: t("emojiPicker.categories.activity"),
        custom: t("emojiPicker.categories.custom"),
        flags: t("emojiPicker.categories.flags"),
        foods: t("emojiPicker.categories.foods"),
        frequent: t("emojiPicker.categories.frequent"),
        nature: t("emojiPicker.categories.nature"),
        objects: t("emojiPicker.categories.objects"),
        people: t("emojiPicker.categories.people"),
        places: t("emojiPicker.categories.places"),
        search: t("emojiPicker.categories.search"),
        symbols: t("emojiPicker.categories.symbols"),
      },
      skins: {
        choose: t("emojiPicker.skins.choose"),
        1: t("emojiPicker.skins.default"),
        2: t("emojiPicker.skins.light"),
        3: t("emojiPicker.skins.mediumLight"),
        4: t("emojiPicker.skins.medium"),
        5: t("emojiPicker.skins.mediumDark"),
        6: t("emojiPicker.skins.dark"),
      },
    }),
    [t],
  )

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (triggerRef?.current?.contains(target)) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    document.addEventListener("mousedown", handleClickOutside, true)
    return () => document.removeEventListener("mousedown", handleClickOutside, true)
  }, [onClose, triggerRef])

  React.useEffect(() => {
    window.addEventListener(CLOSE_BLOCK_MENUS_EVENT, onClose)
    window.addEventListener(CLOSE_EDITOR_MENUS_EVENT, onClose)
    return () => {
      window.removeEventListener(CLOSE_BLOCK_MENUS_EVENT, onClose)
      window.removeEventListener(CLOSE_EDITOR_MENUS_EVENT, onClose)
    }
  }, [onClose])

  React.useEffect(
    () => () => {
      if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current)
    },
    [],
  )

  function cropBounds(zoom = cropZoom) {
    if (!cropDraft) return { x: 0, y: 0 }
    const base = Math.max(
      CROP_SIZE / cropDraft.image.naturalWidth,
      CROP_SIZE / cropDraft.image.naturalHeight,
    )
    return {
      x: Math.max(0, (cropDraft.image.naturalWidth * base * zoom - CROP_SIZE) / 2),
      y: Math.max(0, (cropDraft.image.naturalHeight * base * zoom - CROP_SIZE) / 2),
    }
  }

  function clampOffset(x: number, y: number, zoom = cropZoom) {
    const bounds = cropBounds(zoom)
    return {
      x: Math.max(-bounds.x, Math.min(bounds.x, x)),
      y: Math.max(-bounds.y, Math.min(bounds.y, y)),
    }
  }

  function selectImage(file?: File) {
    if (!file?.type.startsWith("image/")) return
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current)
      cropUrlRef.current = url
      setCropDraft({ image, url, name: file.name.replace(/\.[^.]+$/u, "") })
      setTab("upload")
      setCropZoom(1)
      setCropOffset({ x: 0, y: 0 })
    }
    image.onerror = () => URL.revokeObjectURL(url)
    image.src = url
  }

  function closeCrop() {
    if (cropUrlRef.current) URL.revokeObjectURL(cropUrlRef.current)
    cropUrlRef.current = null
    setCropDraft(null)
  }

  function saveCrop() {
    if (!cropDraft || !cropDraft.name.trim()) return
    const canvas = document.createElement("canvas")
    canvas.width = 256
    canvas.height = 256
    const context = canvas.getContext("2d")
    if (!context) return
    const previewScale = Math.max(
      CROP_SIZE / cropDraft.image.naturalWidth,
      CROP_SIZE / cropDraft.image.naturalHeight,
    )
    const outputRatio = 256 / CROP_SIZE
    context.translate(128 + cropOffset.x * outputRatio, 128 + cropOffset.y * outputRatio)
    context.scale(previewScale * cropZoom * outputRatio, previewScale * cropZoom * outputRatio)
    context.drawImage(
      cropDraft.image,
      -cropDraft.image.naturalWidth / 2,
      -cropDraft.image.naturalHeight / 2,
    )
    const value = canvas.toDataURL("image/webp", 0.86)
    const item: CustomEmoji = {
      id: crypto.randomUUID?.() ?? `${Date.now()}`,
      name: cropDraft.name.trim(),
      value,
    }
    const next = [item, ...customEmoji].slice(0, 24)
    setCustomEmoji(next)
    try {
      localStorage.setItem(CUSTOM_EMOJI_KEY, JSON.stringify(next))
    } catch {
      // The saved emoji remains available during the current session.
    }
    closeCrop()
    onSelect({ native: value })
  }

  const visibleIcons = React.useMemo(
    () => PICKER_ICONS.filter(([name]) => name.includes(iconFilter.trim().toLowerCase())),
    [iconFilter],
  )
  const selectIcon = React.useCallback(
    (name: string) => onSelect({ native: makeIconValue(name, iconColor) }),
    [iconColor, onSelect],
  )
  const tabs: Array<[PickerTab, string]> = emojiOnly
    ? [["emoji", t("emojiPicker.emoji")]]
    : [
        ["emoji", t("emojiPicker.emoji")],
        ["icons", t("emojiPicker.icons")],
        ["upload", t("emojiPicker.upload")],
      ]

  function selectTab(nextTab: PickerTab) {
    setTab(nextTab)
    setVisitedTabs((visited) => {
      if (visited.has(nextTab)) return visited
      const next = new Set(visited)
      next.add(nextTab)
      return next
    })
  }

  return (
    <div
      ref={ref}
      className="amby-emoji-picker-panel flex min-h-[424px] w-[352px] flex-col"
      onPaste={(event) => {
        const file = Array.from(event.clipboardData.files).find((item) =>
          item.type.startsWith("image/"),
        )
        if (file) {
          event.preventDefault()
          selectImage(file)
        }
      }}
    >
      <div className="flex h-11 items-stretch px-2">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={cn(
              "relative px-3 text-xs text-muted-foreground hover:text-foreground",
              tab === value &&
                "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary",
            )}
            onClick={() => selectTab(value)}
          >
            {label}
          </button>
        ))}
        {onClear && (
          <button
            type="button"
            title={t("emojiPicker.removeIcon")}
            aria-label={t("emojiPicker.removeIcon")}
            className="ml-auto flex size-8 self-center items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
            onClick={onClear}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>

      {visitedTabs.has("emoji") && (
        <div className={cn("min-h-0 flex-1", tab !== "emoji" && "hidden")}>
          <StableEmojiMartPicker
            pickerData={data}
            i18n={emojiI18n}
            onEmojiSelect={onSelect}
            theme={resolvedTheme === "dark" ? "dark" : "light"}
          />
        </div>
      )}

      {visitedTabs.has("icons") && (
        <div className={cn("flex h-[380px] flex-col", tab !== "icons" && "hidden")}>
          <div className="relative flex gap-2 border-b border-border p-3">
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-border px-3 focus-within:border-primary">
              <Search className="size-5 text-muted-foreground" />
              <input
                value={iconFilter}
                onChange={(event) => setIconFilter(event.target.value)}
                placeholder={t("emojiPicker.filter")}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <button
              type="button"
              title={t("emojiPicker.iconColor")}
              className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-border hover:bg-accent"
              onClick={() => setColorOpen((open) => !open)}
            >
              <span className="size-4 rounded-full" style={{ backgroundColor: iconColor }} />
            </button>
            {colorOpen && (
              <div className="absolute right-3 top-[58px] z-10 grid grid-cols-3 gap-2 rounded-lg border border-border bg-popover p-2 shadow-lg">
                {ICON_PICKER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    className={cn(
                      "size-7 rounded-full border-2",
                      iconColor === color ? "border-foreground" : "border-transparent",
                    )}
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      setIconColor(color)
                      setColorOpen(false)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          <IconGrid icons={visibleIcons} iconColor={iconColor} onSelect={selectIcon} />
        </div>
      )}

      {visitedTabs.has("upload") && (
        <div
          className={cn(
            "flex h-[380px] flex-col gap-3 overflow-y-auto p-4",
            tab !== "upload" && "hidden",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              selectImage(event.target.files?.[0])
              event.target.value = ""
            }}
          />
          {cropDraft ? (
            <div className="flex flex-col items-center gap-3">
              <input
                value={cropDraft.name}
                onChange={(event) =>
                  setCropDraft((draft) => (draft ? { ...draft, name: event.target.value } : null))
                }
                placeholder={t("emojiPicker.customName")}
                className="h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
              <div
                className="relative size-40 touch-none cursor-move overflow-hidden rounded-xl border border-border bg-accent/30"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  cropDragRef.current = {
                    x: event.clientX,
                    y: event.clientY,
                    offsetX: cropOffset.x,
                    offsetY: cropOffset.y,
                  }
                }}
                onPointerMove={(event) => {
                  const drag = cropDragRef.current
                  if (!drag) return
                  setCropOffset(
                    clampOffset(
                      drag.offsetX + event.clientX - drag.x,
                      drag.offsetY + event.clientY - drag.y,
                    ),
                  )
                }}
                onPointerUp={() => {
                  cropDragRef.current = null
                }}
                onPointerCancel={() => {
                  cropDragRef.current = null
                }}
              >
                <img
                  src={cropDraft.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
                  style={{
                    width:
                      cropDraft.image.naturalWidth *
                      Math.max(
                        CROP_SIZE / cropDraft.image.naturalWidth,
                        CROP_SIZE / cropDraft.image.naturalHeight,
                      ),
                    height:
                      cropDraft.image.naturalHeight *
                      Math.max(
                        CROP_SIZE / cropDraft.image.naturalWidth,
                        CROP_SIZE / cropDraft.image.naturalHeight,
                      ),
                    transform: `translate(calc(-50% + ${cropOffset.x}px), calc(-50% + ${cropOffset.y}px)) scale(${cropZoom})`,
                  }}
                />
                <div className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-foreground/15" />
              </div>
              <label className="flex w-full items-center gap-3 text-xs text-muted-foreground">
                {t("emojiPicker.zoom")}
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.05"
                  value={cropZoom}
                  className="min-w-0 flex-1 accent-primary"
                  onChange={(event) => {
                    const zoom = Number(event.target.value)
                    setCropZoom(zoom)
                    setCropOffset((offset) => clampOffset(offset.x, offset.y, zoom))
                  }}
                />
              </label>
              <div className="flex w-full justify-end gap-2">
                <button
                  type="button"
                  className="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent"
                  onClick={closeCrop}
                >
                  {t("emojiPicker.cancel")}
                </button>
                <button
                  type="button"
                  disabled={!cropDraft.name.trim()}
                  className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  onClick={saveCrop}
                >
                  {t("emojiPicker.saveCustom")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                "flex h-32 w-full shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-accent/20 text-muted-foreground hover:border-primary/50 hover:bg-accent/40",
                dragging && "border-primary bg-accent/60",
              )}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                selectImage(
                  Array.from(event.dataTransfer.files).find((file) =>
                    file.type.startsWith("image/"),
                  ),
                )
              }}
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-background shadow-sm">
                {dragging ? <Upload className="size-4" /> : <ImagePlus className="size-4" />}
              </span>
              <span className="text-sm font-medium text-foreground">
                {t("emojiPicker.uploadImage")}
              </span>
              <span className="text-xs">{t("emojiPicker.dropImage")}</span>
            </button>
          )}
          {!cropDraft && customEmoji.length > 0 && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("emojiPicker.custom")}
              </p>
              <div className="grid grid-cols-4 gap-2">
                {customEmoji.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.name}
                    className="flex min-w-0 flex-col items-center gap-1 rounded-md p-1 hover:bg-accent"
                    onClick={() => onSelect({ native: item.value })}
                  >
                    <IconValue value={item.value} className="size-10" />
                    <span className="w-full truncate text-[10px] text-muted-foreground">
                      {item.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
