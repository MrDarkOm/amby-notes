"use client"

import * as React from "react"
import {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  restoreElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import { useTheme } from "next-themes"
import { useTranslation } from "react-i18next"
import {
  ArrowUpRight,
  ChevronUp,
  Circle,
  Diamond,
  Eraser,
  FileText,
  Frame,
  Globe,
  Hand,
  Image as ImageIcon,
  Library,
  Lock,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Search,
  Settings2,
  Sparkles,
  Square,
  StickyNote,
  Type,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { parseSketch, serializeSketch } from "@/lib/sketch-format"
import { registerEditorSerialization } from "../tiptap/editor-serialization-lifecycle"
import { ToolbarButton } from "../common/toolbar-button"
import { NotePickerModal } from "../common/note-picker-modal"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { toRelativeVaultPath } from "../workspace-tree-utils"
import { EXCALIDRAW_DEFAULT_BG, SKETCH_UI_CARD_COLORS } from "@/themes"
import type { TreeItem } from "../tree/tree-types"
import { SketchErrorBoundary } from "./sketch-error-boundary"
import { SketchNoteEmbeddable } from "./sketch-note-embeddable"
import { SketchToolbar, type SketchShapeType } from "./sketch-objects-toolbar"

function getToolIcon(toolType: string, activeShape: SketchShapeType) {
  switch (toolType) {
    case "selection":
      return MousePointer2
    case "hand":
      return Hand
    case "rectangle":
      return Square
    case "diamond":
      return Diamond
    case "ellipse":
      return Circle
    case "arrow":
      return ArrowUpRight
    case "line":
      return Minus
    case "freedraw":
      return Pencil
    case "text":
      return Type
    case "image":
      return ImageIcon
    case "embeddable":
      return Globe
    case "frame":
      return Frame
    case "laser":
      return Sparkles
    case "eraser":
      return Eraser
    default:
      if (activeShape === "diamond") return Diamond
      if (activeShape === "ellipse") return Circle
      return Square
  }
}

export interface SketchEditorProps {
  value: string
  onChange: (json: string) => void
  onLocalEdit?: () => void
  vault?: string | null
  notePath?: string
  isLocked?: boolean
  onToggleLock?: () => void
  treeItems?: TreeItem[]
  onOpenNote?: (file: string) => void
}

interface ExcalidrawImperativeAPI {
  updateScene: (sceneData: {
    elements?: readonly Record<string, unknown>[]
    appState?: Record<string, unknown>
    commitToHistory?: boolean
  }) => void
  addFiles: (files: readonly unknown[]) => void
  getSceneElements: () => readonly Record<string, unknown>[]
  getAppState: () => Record<string, unknown>
  getFiles: () => Record<string, unknown>
  scrollToContent: (
    target?: unknown,
    opts?: {
      fitToViewport?: boolean
      viewportZoomFactor?: number
      animate?: boolean
      duration?: number
    },
  ) => void
  toggleSidebar: (opts: { name: string; tab?: string; force?: boolean }) => boolean
  setActiveTool: (tool: { type: string; [key: string]: unknown }) => void
  refresh: () => void
}

export function SketchEditor({
  value,
  onChange,
  onLocalEdit,
  vault,
  isLocked: propIsLocked,
  onToggleLock,
  treeItems,
  onOpenNote,
}: SketchEditorProps) {
  const { resolvedTheme, theme } = useTheme()
  const { t, i18n } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const excalidrawAPIRef = React.useRef<ExcalidrawImperativeAPI | null>(null)
  const targetEmbeddableIdRef = React.useRef<string | null>(null)
  const [isApiReady, setIsApiReady] = React.useState(false)
  const [retryKey, setRetryKey] = React.useState(0)

  const [internalLocked, setInternalLocked] = React.useState(false)
  const isLocked = propIsLocked !== undefined ? propIsLocked : internalLocked
  const handleToggleLock = onToggleLock ?? (() => setInternalLocked((prev) => !prev))

  const [canUndo, setCanUndo] = React.useState(false)
  const [canRedo, setCanRedo] = React.useState(false)
  const [isLibraryOpen, setIsLibraryOpen] = React.useState(false)
  const [isMenuOpen, setIsMenuOpen] = React.useState(false)

  const [activeShape, setActiveShape] = React.useState<SketchShapeType>("rectangle")
  const [currentToolType, setCurrentToolType] = React.useState<string>("selection")
  const [isToolsOpen, setIsToolsOpen] = React.useState(false)

  const ActiveToolIcon = getToolIcon(currentToolType, activeShape)

  const syncHistoryRafRef = React.useRef<number | null>(null)
  const syncHistoryState = React.useCallback(() => {
    if (syncHistoryRafRef.current !== null) return
    syncHistoryRafRef.current = requestAnimationFrame(() => {
      syncHistoryRafRef.current = null
      if (!containerRef.current) return
      const undoBtn = containerRef.current.querySelector<HTMLButtonElement>(
        '[data-testid="button-undo"]',
      )
      const redoBtn = containerRef.current.querySelector<HTMLButtonElement>(
        '[data-testid="button-redo"]',
      )
      const nextCanUndo = Boolean(undoBtn && !undoBtn.disabled)
      const nextCanRedo = Boolean(redoBtn && !redoBtn.disabled)
      setCanUndo((prev) => (prev === nextCanUndo ? prev : nextCanUndo))
      setCanRedo((prev) => (prev === nextCanRedo ? prev : nextCanRedo))
    })
  }, [])

  // Align with canonical serialization initially so mount events don't mark as dirty
  const lastInternalJsonRef = React.useRef(serializeSketch(parseSketch(value)))
  const isInitialMountRef = React.useRef(true)
  const isExternalSyncRef = React.useRef(false)
  const userInteractedRef = React.useRef(false)
  const isUserDirtyRef = React.useRef(false)
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange
  const onLocalEditRef = React.useRef(onLocalEdit)
  onLocalEditRef.current = onLocalEdit

  const initialData = React.useMemo(() => {
    const parsed = parseSketch(value)
    const { collaborators: _c, followedBy: _f, ...safeAppState } = parsed.appState
    return {
      elements: parsed.elements,
      appState: {
        ...safeAppState,
        theme: resolvedTheme === "dark" || theme === "dark" ? "dark" : "light",
        viewModeEnabled: Boolean(isLocked),
        viewBackgroundColor:
          safeAppState.viewBackgroundColor &&
          safeAppState.viewBackgroundColor !== EXCALIDRAW_DEFAULT_BG
            ? safeAppState.viewBackgroundColor
            : "transparent",
      },
      files: parsed.files,
      scrollToContent: parsed.elements.length > 0,
    }
    // Only compute initial data once on mount / key change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey])

  // Sync external changes (e.g. recovery restoration or reload) into Excalidraw
  React.useEffect(() => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const canonicalValue = serializeSketch(parseSketch(value))
    if (canonicalValue === lastInternalJsonRef.current) return

    isExternalSyncRef.current = true
    userInteractedRef.current = false
    isUserDirtyRef.current = false
    lastInternalJsonRef.current = canonicalValue
    const parsed = parseSketch(value)
    const { collaborators: _c, followedBy: _f, ...safeAppState } = parsed.appState
    api.updateScene({
      elements: parsed.elements,
      appState: safeAppState,
      commitToHistory: false,
    })
    if (parsed.files && Object.keys(parsed.files).length > 0) {
      api.addFiles(Object.values(parsed.files))
    }
    requestAnimationFrame(() => {
      api.refresh()
    })
    queueMicrotask(() => {
      isExternalSyncRef.current = false
    })
  }, [value, isApiReady])

  React.useEffect(() => {
    const api = excalidrawAPIRef.current
    if (!api) return
    api.updateScene({
      appState: { viewModeEnabled: Boolean(isLocked) },
      commitToHistory: false,
    })
  }, [isLocked, isApiReady])

  const flushSketch = React.useCallback(() => {
    if (!isUserDirtyRef.current) return
    const api = excalidrawAPIRef.current
    if (!api) return
    const elements = api.getSceneElements()
    const appState = api.getAppState()
    const files = api.getFiles()
    const serialized = serializeSketch({
      elements: elements as readonly Record<string, unknown>[],
      appState: appState as unknown as Record<string, unknown>,
      files: files as unknown as Record<string, unknown>,
    })
    if (serialized !== lastInternalJsonRef.current) {
      lastInternalJsonRef.current = serialized
      isUserDirtyRef.current = false
      onChangeRef.current(serialized)
    }
  }, [])

  React.useEffect(() => registerEditorSerialization({ flush: flushSketch }), [flushSketch])
  React.useEffect(() => () => flushSketch(), [flushSketch])

  type ExcalidrawProps = React.ComponentProps<typeof Excalidraw>

  const handleChange: NonNullable<ExcalidrawProps["onChange"]> = React.useCallback(
    (elements, appState, files) => {
      const serialized = serializeSketch({
        elements: elements as readonly Record<string, unknown>[],
        appState: appState as unknown as Record<string, unknown>,
        files: files as unknown as Record<string, unknown>,
      })

      if (isInitialMountRef.current) {
        isInitialMountRef.current = false
        lastInternalJsonRef.current = serialized
        return
      }

      if (isExternalSyncRef.current) {
        lastInternalJsonRef.current = serialized
        return
      }

      if (!userInteractedRef.current) {
        lastInternalJsonRef.current = serialized
        return
      }

      if (serialized !== lastInternalJsonRef.current) {
        lastInternalJsonRef.current = serialized
        isUserDirtyRef.current = true
        onChangeRef.current(serialized)
        onLocalEditRef.current?.()
      }

      const newIsLibraryOpen = Boolean(appState.openSidebar?.name === "default")
      setIsLibraryOpen((prev) => (prev === newIsLibraryOpen ? prev : newIsLibraryOpen))

      const newIsMenuOpen = appState.openMenu === "canvas"
      setIsMenuOpen((prev) => (prev === newIsMenuOpen ? prev : newIsMenuOpen))

      const activeTool = (appState.activeTool as { type?: string })?.type
      if (activeTool) {
        setCurrentToolType((prev) => (prev === activeTool ? prev : activeTool))
        if (activeTool === "rectangle" || activeTool === "diamond" || activeTool === "ellipse") {
          setActiveShape((prev) => (prev === activeTool ? prev : (activeTool as SketchShapeType)))
        }
      }

      syncHistoryState()
    },
    [syncHistoryState],
  )

  const isDark = resolvedTheme === "dark" || theme === "dark"
  const langCode = i18n.language.startsWith("ru") ? "ru-RU" : "en"

  const uiOptions: ExcalidrawProps["UIOptions"] = React.useMemo(
    () => ({
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
        export: { saveFileToDisk: true },
        saveAsImage: true,
        theme: false,
      },
    }),
    [],
  )

  const handleReset = React.useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  const handleUndo = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="button-undo"]',
    )
    btn?.click()
    syncHistoryState()
  }, [syncHistoryState])

  const handleRedo = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="button-redo"]',
    )
    btn?.click()
    syncHistoryState()
  }, [syncHistoryState])

  const handleZoomIn = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(".zoom-in-button")
    if (btn) {
      btn.click()
    } else if (excalidrawAPIRef.current) {
      const appState = excalidrawAPIRef.current.getAppState()
      const currentZoom = Number((appState.zoom as { value?: number })?.value ?? 1)
      const nextZoom = Math.min(currentZoom + 0.1, 5)
      excalidrawAPIRef.current.updateScene({ appState: { zoom: { value: nextZoom } } })
    }
  }, [])

  const handleZoomOut = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(".zoom-out-button")
    if (btn) {
      btn.click()
    } else if (excalidrawAPIRef.current) {
      const appState = excalidrawAPIRef.current.getAppState()
      const currentZoom = Number((appState.zoom as { value?: number })?.value ?? 1)
      const nextZoom = Math.max(currentZoom - 0.1, 0.1)
      excalidrawAPIRef.current.updateScene({ appState: { zoom: { value: nextZoom } } })
    }
  }, [])

  const handleFitView = React.useCallback(() => {
    excalidrawAPIRef.current?.scrollToContent(undefined, { fitToViewport: true, animate: true })
  }, [])

  const handleToggleLibrary = React.useCallback(() => {
    const api = excalidrawAPIRef.current
    if (!api) return
    if (isLibraryOpen) {
      api.toggleSidebar({ name: "default", force: false })
    } else {
      if (isMenuOpen) {
        api.updateScene({ appState: { openMenu: null } })
      }
      api.toggleSidebar({ name: "default", tab: "library" })
    }
  }, [isLibraryOpen, isMenuOpen])

  const handleToggleSettings = React.useCallback(() => {
    const api = excalidrawAPIRef.current
    if (isMenuOpen) {
      api?.updateScene({ appState: { openMenu: null } })
    } else {
      if (isLibraryOpen) {
        api?.toggleSidebar({ name: "default", force: false })
      }
      const trigger = containerRef.current?.querySelector<HTMLButtonElement>(".main-menu-trigger")
      trigger?.click()
    }
  }, [isLibraryOpen, isMenuOpen])

  const [notePickerOpen, setNotePickerOpen] = React.useState(false)

  const handleAddTextCard = React.useCallback(() => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const appState = api.getAppState()
    const rect = containerRef.current?.getBoundingClientRect()
    const clientX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
    const clientY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2

    const sceneCoords = viewportCoordsToSceneCoords(
      { clientX, clientY },
      {
        zoom: appState.zoom as never,
        offsetLeft: Number(appState.offsetLeft ?? 0),
        offsetTop: Number(appState.offsetTop ?? 0),
        scrollX: Number(appState.scrollX ?? 0),
        scrollY: Number(appState.scrollY ?? 0),
      },
    )

    const width = 240
    const height = 140
    const x = Math.round(sceneCoords.x - width / 2)
    const y = Math.round(sceneCoords.y - height / 2)
    const cardColors = isDark ? SKETCH_UI_CARD_COLORS.dark : SKETCH_UI_CARD_COLORS.light

    const newElements = convertToExcalidrawElements([
      {
        type: "rectangle",
        x,
        y,
        width,
        height,
        strokeColor: cardColors.textCardStroke,
        backgroundColor: cardColors.textCardBackground,
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 1,
        roundness: { type: 3 },
        label: {
          text: t("canvas.textPlaceholder") || "Текст...",
          fontSize: 16,
          textAlign: "center",
          verticalAlign: "middle",
        },
      },
    ])

    const currentElements = api.getSceneElements()
    const rectElement = newElements[0]
    api.updateScene({
      elements: [...currentElements, ...newElements],
      appState: {
        selectedElementIds: rectElement ? { [rectElement.id]: true } : {},
      },
      commitToHistory: true,
    })
    userInteractedRef.current = true
    isUserDirtyRef.current = true
    onLocalEditRef.current?.()
    flushSketch()
  }, [flushSketch, isDark, t])

  const handleSelectTool = React.useCallback((tool: string) => {
    setCurrentToolType(tool)
    excalidrawAPIRef.current?.setActiveTool({ type: tool as never })
  }, [])

  const handleSelectShape = React.useCallback((shape: SketchShapeType) => {
    setActiveShape(shape)
    setCurrentToolType(shape)
    excalidrawAPIRef.current?.setActiveTool({ type: shape })
  }, [])

  const handleAddNoteCard = React.useCallback(() => {
    setNotePickerOpen(true)
  }, [])

  const handleSelectNote = React.useCallback(
    (selectedPath: string) => {
      const api = excalidrawAPIRef.current
      if (!api) return
      const relPath = toRelativeVaultPath(selectedPath, vault ?? undefined)
      const newLink = `amby://note/${encodeURIComponent(relPath)}`

      // If updating an existing embeddable via "Browse" button
      if (targetEmbeddableIdRef.current) {
        const targetId = targetEmbeddableIdRef.current
        targetEmbeddableIdRef.current = null
        const currentElements = api.getSceneElements()
        const updatedElements = currentElements.map((el) => {
          if (String(el.id) === targetId && el.type === "embeddable") {
            return {
              ...el,
              link: newLink,
              version: Number(el.version ?? 0) + 1,
              versionNonce: Math.floor(Math.random() * 1000000),
            }
          }
          return el
        })
        api.updateScene({
          elements: updatedElements,
          commitToHistory: true,
        })
        userInteractedRef.current = true
        isUserDirtyRef.current = true
        onLocalEditRef.current?.()
        flushSketch()
        return
      }

      const appState = api.getAppState()
      const rect = containerRef.current?.getBoundingClientRect()
      const clientX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
      const clientY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2

      const sceneCoords = viewportCoordsToSceneCoords(
        { clientX, clientY },
        {
          zoom: appState.zoom as never,
          offsetLeft: Number(appState.offsetLeft ?? 0),
          offsetTop: Number(appState.offsetTop ?? 0),
          scrollX: Number(appState.scrollX ?? 0),
          scrollY: Number(appState.scrollY ?? 0),
        },
      )

      const width = 320
      const height = 200
      const x = Math.round(sceneCoords.x - width / 2)
      const y = Math.round(sceneCoords.y - height / 2)
      const cardColors = isDark ? SKETCH_UI_CARD_COLORS.dark : SKETCH_UI_CARD_COLORS.light

      const [embedElement] = restoreElements(
        [
          {
            type: "embeddable",
            x,
            y,
            width,
            height,
            link: newLink,
            roundness: { type: 3 },
            strokeColor: cardColors.noteCardStroke,
            backgroundColor: cardColors.noteCardBackground,
            fillStyle: "solid",
            strokeWidth: 1,
            roughness: 0,
          } as unknown as NonNullable<Parameters<typeof restoreElements>[0]>[number],
        ],
        null,
      )

      const currentElements = api.getSceneElements()
      api.updateScene({
        elements: [...currentElements, embedElement],
        appState: {
          selectedElementIds: embedElement ? { [embedElement.id]: true } : {},
        },
        commitToHistory: true,
      })
      userInteractedRef.current = true
      isUserDirtyRef.current = true
      onLocalEditRef.current?.()
      flushSketch()
    },
    [flushSketch, isDark, vault],
  )

  const validateEmbeddable = React.useCallback(
    (link: string) =>
      Boolean(link && (link.startsWith("amby://note/") || link.startsWith("note:"))),
    [],
  )

  const renderEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]> = React.useCallback(
    (element) => {
      if (element.link?.startsWith("amby://note/")) {
        const rawPath = element.link.slice("amby://note/".length)
        const notePath = decodeURIComponent(rawPath)
        return <SketchNoteEmbeddable notePath={notePath} vault={vault} onOpenNote={onOpenNote} />
      }
      return null
    },
    [vault, onOpenNote],
  )

  const handleLinkOpen: NonNullable<ExcalidrawProps["onLinkOpen"]> = React.useCallback(
    (element, event) => {
      if (element.link?.startsWith("amby://note/")) {
        event.preventDefault()
        const rawPath = element.link.slice("amby://note/".length)
        const notePath = decodeURIComponent(rawPath)
        onOpenNote?.(notePath)
      }
    },
    [onOpenNote],
  )

  const handleNotePickerOpenChange = React.useCallback((open: boolean) => {
    setNotePickerOpen(open)
    if (!open) {
      targetEmbeddableIdRef.current = null
    }
  }, [])

  // Observe Excalidraw's hyperlink container to format note paths and add the "Browse" button
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const enhanceHyperlinkContainer = () => {
      const popups = container.querySelectorAll<HTMLElement>(".excalidraw-hyperlinkContainer")
      for (const popup of popups) {
        const linkEl = popup.querySelector<HTMLAnchorElement>(".excalidraw-hyperlinkContainer-link")
        if (!linkEl) continue

        const href = linkEl.getAttribute("href") || linkEl.textContent || ""
        const isAmbyNote =
          href.includes("amby://note/") || (linkEl.textContent?.includes("amby://note/") ?? false)
        if (!isAmbyNote) continue

        popup.setAttribute("data-amby-note", "true")

        const match =
          href.match(/amby:\/\/note\/([^"'\s]+)/) ||
          (linkEl.textContent?.match(/amby:\/\/note\/([^"'\s]+)/) ?? null)
        if (match) {
          try {
            const decoded = decodeURIComponent(match[1])
            const readable = decoded.replace(/\//g, " / ")
            if (linkEl.textContent !== readable) {
              linkEl.textContent = readable
              linkEl.title = decoded
            }
          } catch {
            // ignore malformed URI
          }
        }

        const buttonsContainer = popup.querySelector<HTMLElement>(
          ".excalidraw-hyperlinkContainer__buttons",
        )
        if (buttonsContainer) {
          let browseBtn =
            buttonsContainer.querySelector<HTMLButtonElement>(".amby-sketch-browse-btn")
          if (!browseBtn) {
            browseBtn = document.createElement("button")
            browseBtn.className = "amby-sketch-browse-btn"
            browseBtn.type = "button"
            browseBtn.textContent = t("sketch.browse")
            browseBtn.title = t("sketch.browse")
            browseBtn.onclick = (e) => {
              e.preventDefault()
              e.stopPropagation()
              const api = excalidrawAPIRef.current
              if (api) {
                const appState = api.getAppState()
                const selectedElementIds = (appState.selectedElementIds ?? {}) as Record<
                  string,
                  boolean
                >
                const selectedIds = Object.keys(selectedElementIds).filter(
                  (id) => selectedElementIds[id],
                )
                const elements = api.getSceneElements()
                const targetEl =
                  elements.find(
                    (el) => selectedIds.includes(String(el.id)) && el.type === "embeddable",
                  ) ??
                  elements.find(
                    (el) =>
                      el.type === "embeddable" &&
                      typeof el.link === "string" &&
                      match &&
                      el.link.includes(match[1]),
                  )
                if (targetEl) {
                  targetEmbeddableIdRef.current = String(targetEl.id)
                }
              }
              setNotePickerOpen(true)
            }
            buttonsContainer.appendChild(browseBtn)
          } else if (browseBtn.textContent !== t("sketch.browse")) {
            browseBtn.textContent = t("sketch.browse")
            browseBtn.title = t("sketch.browse")
          }
        }
      }
    }

    const observer = new MutationObserver(() => {
      enhanceHyperlinkContainer()
    })

    observer.observe(container, { childList: true, subtree: true })
    enhanceHyperlinkContainer()

    return () => {
      observer.disconnect()
    }
  }, [t])

  const [containerWidth, setContainerWidth] = React.useState<number>(1000)

  React.useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.round(entry.contentRect.width)
        setContainerWidth((prev) => (Math.abs(prev - width) > 2 ? width : prev))
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  React.useEffect(() => {
    const timer = setTimeout(() => {
      excalidrawAPIRef.current?.refresh()
    }, 60)
    return () => clearTimeout(timer)
  }, [])

  const isNarrow = containerWidth < 720

  const handleExcalidrawAPI = React.useCallback(
    (api: unknown) => {
      const imperativeApi = api as ExcalidrawImperativeAPI
      if (excalidrawAPIRef.current === imperativeApi) return
      excalidrawAPIRef.current = imperativeApi
      setIsApiReady(true)
      syncHistoryState()
      requestAnimationFrame(() => {
        imperativeApi.refresh()
      })
    },
    [syncHistoryState],
  )

  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)

  return (
    <div
      ref={containerRef}
      className="amby-sketch-editor relative h-full w-full overflow-hidden bg-[var(--note-surface)]"
      style={{ width: "100%", height: "100%", position: "relative" }}
      onPointerDown={() => {
        userInteractedRef.current = true
      }}
      onKeyDown={() => {
        userInteractedRef.current = true
      }}
    >
      <SketchErrorBoundary key={retryKey} onReset={handleReset}>
        <Excalidraw
          excalidrawAPI={handleExcalidrawAPI}
          initialData={initialData as ExcalidrawProps["initialData"]}
          onChange={handleChange}
          theme={isDark ? "dark" : "light"}
          langCode={langCode}
          UIOptions={uiOptions}
          autoFocus={false}
          viewModeEnabled={Boolean(isLocked)}
          validateEmbeddable={validateEmbeddable}
          renderEmbeddable={renderEmbeddable}
          onLinkOpen={handleLinkOpen}
        >
          <MainMenu>
            <MainMenu.Item
              icon={<StickyNote className="size-4" />}
              data-testid="add-text-card-button"
              aria-label={t("sketch.textCard")}
              onSelect={handleAddTextCard}
            >
              {t("sketch.textCard")}
            </MainMenu.Item>
            <MainMenu.Item
              icon={<FileText className="size-4" />}
              data-testid="add-note-card-button"
              aria-label={t("sketch.noteCard")}
              onSelect={handleAddNoteCard}
            >
              {t("sketch.noteCard")}
            </MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Export />
            <MainMenu.Item
              icon={<Search className="size-4" />}
              shortcut={isMac ? "Cmd+F" : "Ctrl+F"}
              data-testid="search-menu-button"
              aria-label={t("sketch.findOnCanvas")}
              onSelect={() => {
                excalidrawAPIRef.current?.toggleSidebar({ name: "default", tab: "search" })
              }}
            >
              {t("sketch.findOnCanvas")}
            </MainMenu.Item>
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.Separator />
            <MainMenu.Group title={t("sketch.excalidrawLinks")}>
              <MainMenu.DefaultItems.Socials />
            </MainMenu.Group>
          </MainMenu>
        </Excalidraw>
      </SketchErrorBoundary>

      {/* Unified Toolbar Controls (Selection, Hand, Объект flyout, Стикер, Прикрепить заметку, Drawing tools, More tools) */}
      {!isLocked && (
        <div className="absolute bottom-2 left-4 z-10 select-none">
          {isNarrow ? (
            <Popover open={isToolsOpen} onOpenChange={setIsToolsOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title={t("sketch.tools")}
                  aria-label={t("sketch.tools")}
                  data-testid="sketch-collapsed-tools-trigger"
                  className={cn(
                    "flex h-9 items-center gap-1.5 rounded-xl border border-border/80 bg-card/90 px-2.5 text-foreground shadow-md backdrop-blur-md hover:bg-accent hover:text-accent-foreground select-none",
                    isToolsOpen && "bg-accent text-accent-foreground font-medium",
                  )}
                >
                  <ActiveToolIcon className="size-3.5" />
                  <ChevronUp className="size-3 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-auto border-0 bg-transparent p-0 shadow-none"
              >
                <SketchToolbar
                  activeTool={currentToolType}
                  activeShape={activeShape}
                  onSelectTool={(tool) => {
                    handleSelectTool(tool)
                    setIsToolsOpen(false)
                  }}
                  onSelectShape={handleSelectShape}
                  onAddTextCard={() => {
                    handleAddTextCard()
                    setIsToolsOpen(false)
                  }}
                  onAddNoteCard={() => {
                    handleAddNoteCard()
                    setIsToolsOpen(false)
                  }}
                  className="rounded-xl border border-border/80 bg-card/95 p-1 shadow-lg backdrop-blur-md"
                />
              </PopoverContent>
            </Popover>
          ) : (
            <SketchToolbar
              activeTool={currentToolType}
              activeShape={activeShape}
              onSelectTool={handleSelectTool}
              onSelectShape={handleSelectShape}
              onAddTextCard={handleAddTextCard}
              onAddNoteCard={handleAddNoteCard}
              className="rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md"
            />
          )}
        </div>
      )}

      {/* Floating Library Button (Size & position matching Canvas Minimap) */}
      {!isLibraryOpen && !isMenuOpen && (
        <div className="absolute bottom-14 right-4 z-10 select-none">
          <button
            type="button"
            title={t("sketch.showLibrary")}
            onClick={handleToggleLibrary}
            className="flex size-8 items-center justify-center rounded-xl border border-border/80 bg-card/90 text-foreground shadow-md backdrop-blur-md hover:bg-accent hover:text-accent-foreground"
          >
            <Library className="size-4" />
          </button>
        </div>
      )}

      {/* Area Controls (Identical to Canvas Toolbar) */}
      <div className="absolute bottom-2 right-4 z-10 flex items-center select-none">
        <div className="flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-md backdrop-blur-md">
          <ToolbarButton title={t("canvas.zoomOut")} onClick={handleZoomOut}>
            <ZoomOut className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title={t("canvas.zoomIn")} onClick={handleZoomIn}>
            <ZoomIn className="size-3.5" />
          </ToolbarButton>

          <div className="mx-0.5 h-3.5 w-px bg-border/80" />

          <ToolbarButton title={t("canvas.fitView")} onClick={handleFitView}>
            <Maximize2 className="size-3.5" />
          </ToolbarButton>

          {!isLocked && (
            <>
              <div className="mx-0.5 h-3.5 w-px bg-border/80" />
              <ToolbarButton
                title={`${t("canvas.undo")} (⌘Z)`}
                disabled={!canUndo}
                onClick={handleUndo}
              >
                <Undo2 className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title={`${t("canvas.redo")} (⇧⌘Z)`}
                disabled={!canRedo}
                onClick={handleRedo}
              >
                <Redo2 className="size-3.5" />
              </ToolbarButton>
            </>
          )}

          <div className="mx-0.5 h-3.5 w-px bg-border/80" />

          <ToolbarButton
            title={isLocked ? t("docEditor.editMode") : t("docEditor.viewMode")}
            active={isLocked}
            onClick={handleToggleLock}
          >
            {isLocked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
          </ToolbarButton>

          <ToolbarButton
            title={t("canvas.settings")}
            active={isMenuOpen}
            data-prevent-outside-click={true}
            onClick={handleToggleSettings}
          >
            <Settings2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>

      {/* Vault Note Picker Modal */}
      <NotePickerModal
        open={notePickerOpen}
        onOpenChange={handleNotePickerOpenChange}
        treeItems={treeItems ?? []}
        vault={vault}
        onSelectNote={handleSelectNote}
      />
    </div>
  )
}
