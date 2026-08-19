"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Maximize2, Minimize2, Minus, X } from "lucide-react"

import { isTauri } from "@/lib/storage"

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)

/** Minimal draggable header shown on the empty-vault screen. */
export function EmptyStateHeader() {
  const { t } = useTranslation()
  const [isMaximized, setIsMaximized] = React.useState(false)
  const lastClickRef = React.useRef(0)

  React.useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    win
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {})
    let unlisten: (() => void) | undefined
    win
      .onResized(() =>
        win
          .isMaximized()
          .then(setIsMaximized)
          .catch(() => {}),
      )
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || !isTauri()) return
    e.preventDefault()
    const now = Date.now()
    const since = now - lastClickRef.current
    lastClickRef.current = now
    if (since < 300) {
      lastClickRef.current = 0
      getCurrentWindow().toggleMaximize()
    } else {
      getCurrentWindow()
        .startDragging()
        .catch(() => {})
    }
  }

  return (
    <header className="relative z-50 flex h-10 shrink-0 select-none items-stretch border-b border-border bg-background">
      {/* macOS traffic-light spacer */}
      {isMac && <div className="w-20 shrink-0" onMouseDown={handleMouseDown} />}

      {/* Logo / app name */}
      <div className="flex shrink-0 items-center gap-2 px-3" onMouseDown={handleMouseDown}>
        <span className="text-sm font-semibold text-foreground">{t("app.name")}</span>
      </div>

      {/* Drag region fills the rest */}
      <div className="h-full flex-1 cursor-default" onMouseDown={handleMouseDown} />

      {/* Windows: window controls */}
      {!isMac && (
        <div className="flex shrink-0 items-center">
          <button
            onClick={() => isTauri() && getCurrentWindow().minimize()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            <Minus className="size-4" />
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().toggleMaximize()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-white"
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            onClick={() => isTauri() && getCurrentWindow().close()}
            className="flex h-10 w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </header>
  )
}
