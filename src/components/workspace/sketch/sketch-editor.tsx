"use client"

import * as React from "react"
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import { useTheme } from "next-themes"
import { useTranslation } from "react-i18next"
import {
  Library,
  Lock,
  Maximize2,
  Redo2,
  Search,
  Settings2,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { parseSketch, serializeSketch } from "@/lib/sketch-format"
import { registerEditorSerialization } from "../tiptap/editor-serialization-lifecycle"
import { ToolbarButton } from "../canvas/canvas-toolbar"
import { SketchErrorBoundary } from "./sketch-error-boundary"

export interface SketchEditorProps {
  value: string
  onChange: (json: string) => void
  onLocalEdit?: () => void
  vault?: string | null
  notePath?: string
  isLocked?: boolean
  onToggleLock?: () => void
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
}

export function SketchEditor({
  value,
  onChange,
  onLocalEdit,
  isLocked: propIsLocked,
  onToggleLock,
}: SketchEditorProps) {
  const { resolvedTheme, theme } = useTheme()
  const { t, i18n } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [excalidrawAPI, setExcalidrawAPI] = React.useState<ExcalidrawImperativeAPI | null>(null)
  const [retryKey, setRetryKey] = React.useState(0)

  const [internalLocked, setInternalLocked] = React.useState(false)
  const isLocked = propIsLocked !== undefined ? propIsLocked : internalLocked
  const handleToggleLock = onToggleLock ?? (() => setInternalLocked((prev) => !prev))

  const [canUndo, setCanUndo] = React.useState(false)
  const [canRedo, setCanRedo] = React.useState(false)
  const [isLibraryOpen, setIsLibraryOpen] = React.useState(false)
  const [isMenuOpen, setIsMenuOpen] = React.useState(false)

  const syncHistoryState = React.useCallback(() => {
    if (!containerRef.current) return
    const undoBtn = containerRef.current.querySelector<HTMLButtonElement>(
      '[data-testid="button-undo"]',
    )
    const redoBtn = containerRef.current.querySelector<HTMLButtonElement>(
      '[data-testid="button-redo"]',
    )
    setCanUndo(Boolean(undoBtn && !undoBtn.disabled))
    setCanRedo(Boolean(redoBtn && !redoBtn.disabled))
  }, [])

  // Align with canonical serialization initially so mount events don't mark as dirty
  const lastInternalJsonRef = React.useRef(serializeSketch(parseSketch(value)))
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
      },
      files: parsed.files,
      scrollToContent: parsed.elements.length > 0,
    }
    // Only compute initial data once on mount / key change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey])

  // Sync external changes (e.g. recovery restoration or reload) into Excalidraw
  React.useEffect(() => {
    if (!excalidrawAPI) return
    const canonicalValue = serializeSketch(parseSketch(value))
    if (canonicalValue === lastInternalJsonRef.current) return

    lastInternalJsonRef.current = canonicalValue
    const parsed = parseSketch(value)
    const { collaborators: _c, followedBy: _f, ...safeAppState } = parsed.appState
    excalidrawAPI.updateScene({
      elements: parsed.elements,
      appState: safeAppState,
      commitToHistory: false,
    })
    if (parsed.files && Object.keys(parsed.files).length > 0) {
      excalidrawAPI.addFiles(Object.values(parsed.files))
    }
  }, [excalidrawAPI, value])

  React.useEffect(() => {
    if (!excalidrawAPI) return
    excalidrawAPI.updateScene({
      appState: { viewModeEnabled: Boolean(isLocked) },
      commitToHistory: false,
    })
  }, [excalidrawAPI, isLocked])

  const flushSketch = React.useCallback(() => {
    if (!excalidrawAPI) return
    const elements = excalidrawAPI.getSceneElements()
    const appState = excalidrawAPI.getAppState()
    const files = excalidrawAPI.getFiles()
    const serialized = serializeSketch({
      elements: elements as readonly Record<string, unknown>[],
      appState: appState as unknown as Record<string, unknown>,
      files: files as unknown as Record<string, unknown>,
    })
    if (serialized !== lastInternalJsonRef.current) {
      lastInternalJsonRef.current = serialized
      onChangeRef.current(serialized)
      onLocalEditRef.current?.()
    }
  }, [excalidrawAPI])

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
      if (serialized !== lastInternalJsonRef.current) {
        lastInternalJsonRef.current = serialized
        onChangeRef.current(serialized)
        onLocalEditRef.current?.()
      }

      setIsLibraryOpen(Boolean(appState.openSidebar?.name === "default"))
      setIsMenuOpen(appState.openMenu === "canvas")
      requestAnimationFrame(syncHistoryState)
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
    requestAnimationFrame(syncHistoryState)
  }, [syncHistoryState])

  const handleRedo = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="button-redo"]',
    )
    btn?.click()
    requestAnimationFrame(syncHistoryState)
  }, [syncHistoryState])

  const handleZoomIn = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(".zoom-in-button")
    if (btn) {
      btn.click()
    } else if (excalidrawAPI) {
      const appState = excalidrawAPI.getAppState()
      const currentZoom = Number((appState.zoom as { value?: number })?.value ?? 1)
      const nextZoom = Math.min(currentZoom + 0.1, 5)
      excalidrawAPI.updateScene({ appState: { zoom: { value: nextZoom } } })
    }
  }, [excalidrawAPI])

  const handleZoomOut = React.useCallback(() => {
    const btn = containerRef.current?.querySelector<HTMLButtonElement>(".zoom-out-button")
    if (btn) {
      btn.click()
    } else if (excalidrawAPI) {
      const appState = excalidrawAPI.getAppState()
      const currentZoom = Number((appState.zoom as { value?: number })?.value ?? 1)
      const nextZoom = Math.max(currentZoom - 0.1, 0.1)
      excalidrawAPI.updateScene({ appState: { zoom: { value: nextZoom } } })
    }
  }, [excalidrawAPI])

  const handleFitView = React.useCallback(() => {
    excalidrawAPI?.scrollToContent(undefined, { fitToViewport: true, animate: true })
  }, [excalidrawAPI])

  const handleToggleLibrary = React.useCallback(() => {
    if (!excalidrawAPI) return
    excalidrawAPI.toggleSidebar({ name: "default" })
  }, [excalidrawAPI])

  const handleToggleSettings = React.useCallback(() => {
    if (isMenuOpen) {
      excalidrawAPI?.updateScene({ appState: { openMenu: null } })
    } else {
      const trigger = containerRef.current?.querySelector<HTMLButtonElement>(".main-menu-trigger")
      trigger?.click()
    }
  }, [excalidrawAPI, isMenuOpen])

  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)

  return (
    <div
      ref={containerRef}
      className="amby-sketch-editor relative h-full w-full overflow-hidden bg-transparent"
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <SketchErrorBoundary key={retryKey} onReset={handleReset}>
        <Excalidraw
          excalidrawAPI={(api) => {
            setExcalidrawAPI(api as unknown as ExcalidrawImperativeAPI)
            requestAnimationFrame(syncHistoryState)
          }}
          initialData={initialData as ExcalidrawProps["initialData"]}
          onChange={handleChange}
          theme={isDark ? "dark" : "light"}
          langCode={langCode}
          UIOptions={uiOptions}
          autoFocus={false}
          viewModeEnabled={Boolean(isLocked)}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.Export />
            <MainMenu.Item
              icon={<Search className="size-4" />}
              shortcut={isMac ? "Cmd+F" : "Ctrl+F"}
              data-testid="search-menu-button"
              aria-label={t("sketch.findOnCanvas")}
              onSelect={() => {
                excalidrawAPI?.toggleSidebar({ name: "default", tab: "search" })
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
    </div>
  )
}
