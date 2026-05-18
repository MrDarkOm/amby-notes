"use client"

import * as React from "react"
import type { Editor, Range } from "@tiptap/core"

import {
  getPlusItems,
  getSlashItems,
  type BlockInsertItem,
  type BlockMediaContext,
} from "./block-insert-items"
import { EmojiPickerPanel } from "./EmojiPickerPanel"
import { isTauri } from "@/lib/storage"
import { useSmartPlacement, type AnchorRect } from "./use-smart-placement"

type Mode = "list" | "url" | "emoji"

interface Props {
  editor: Editor
  vaultPath?: string
  notePath?: string
  /** "plus" — opened from the "+" rail. "slash" — opened from / suggestion. */
  source?: "plus" | "slash"
  /** Range to delete before applying an item (slash trigger only). */
  range?: Range
  /** Viewport-coords anchor. Panel auto-flips above when overflowing below. */
  anchorRect: AnchorRect
  onClose: () => void
}

export function BlockInsertPanel({
  editor,
  vaultPath,
  notePath,
  source = "plus",
  range,
  anchorRect,
  onClose,
}: Props) {
  const [mode, setMode] = React.useState<Mode>("list")
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const [urlValue, setUrlValue] = React.useState("")
  const searchRef = React.useRef<HTMLInputElement>(null)
  const urlRef = React.useRef<HTMLInputElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const placementStyle = useSmartPlacement(anchorRect, panelRef)
  const tauri = isTauri()

  const all = React.useMemo(
    () => (source === "slash" ? getSlashItems() : getPlusItems()),
    [source],
  )

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? all.filter(i => `${i.title} ${i.hint}`.toLowerCase().includes(q))
      : all
    return list
  }, [all, query])

  React.useEffect(() => {
    if (mode === "list") searchRef.current?.focus()
    if (mode === "url") urlRef.current?.focus()
  }, [mode])

  React.useEffect(() => {
    setActive(0)
  }, [query, mode])

  function maybeDeleteSlashRange() {
    if (source === "slash" && range) {
      editor.chain().focus().deleteRange(range).run()
    }
  }

  const ctx: BlockMediaContext = {
    vaultPath,
    notePath,
    requestUrlInput: () => {
      maybeDeleteSlashRange()
      setUrlValue("")
      setMode("url")
    },
    requestEmojiPicker: () => {
      maybeDeleteSlashRange()
      setMode("emoji")
    },
  }

  function itemDisabled(item: BlockInsertItem): boolean {
    if (item.category !== "media") return false
    if (item.id === "image-url") return false
    if (item.id === "emoji") return false
    return !tauri
  }

  function choose(item: BlockInsertItem) {
    if (itemDisabled(item)) return
    if (item.id === "image-url" || item.id === "emoji") {
      // These items take over the panel; no slash-range delete yet (they may bail).
      void item.inline(editor, ctx)
      return
    }
    maybeDeleteSlashRange()
    void item.inline(editor, ctx)
    onClose()
  }

  function applyUrl() {
    const url = urlValue.trim()
    if (!url) return
    editor.chain().focus().insertContent({ type: "image", attrs: { src: url } }).run()
    onClose()
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      if (mode !== "list") setMode("list")
      else onClose()
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const item = filtered[active]
      if (item) choose(item)
      return
    }
    if (filtered.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive(a => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive(a => Math.max(a - 1, 0))
    }
  }

  function onUrlKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault()
      applyUrl()
    } else if (e.key === "Escape") {
      e.preventDefault()
      setMode("list")
    }
  }

  return (
    <div
      ref={panelRef}
      className="amby-block-panel amby-block-panel--insert"
      data-mode={mode}
      style={placementStyle}
      onMouseDown={e => e.preventDefault()}
    >
      {mode === "list" && (
        <>
          <div className="amby-block-panel-header">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onListKeyDown}
              placeholder="Поиск блока…"
              className="amby-block-panel-search"
            />
          </div>
          <div className="amby-block-panel-body" onKeyDown={onListKeyDown} tabIndex={-1}>
            {filtered.length === 0 ? (
              <div className="amby-block-panel-empty">Ничего не найдено</div>
            ) : (
              filtered.map((item, idx) => {
                const disabled = itemDisabled(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={disabled}
                    className={
                      "amby-block-row" +
                      (active === idx ? " is-active" : "") +
                      (disabled ? " is-disabled" : "")
                    }
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => choose(item)}
                  >
                    <item.icon className="amby-block-row-icon" />
                    <span className="amby-block-row-label">{item.title}</span>
                    <span className="amby-block-row-hint">{item.hint}</span>
                  </button>
                )
              })
            )}
          </div>
          <div className="amby-block-panel-footer">
            <button type="button" className="amby-block-panel-close" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </>
      )}

      {mode === "url" && (
        <div className="amby-block-panel-url">
          <input
            ref={urlRef}
            type="url"
            value={urlValue}
            onChange={e => setUrlValue(e.target.value)}
            onKeyDown={onUrlKeyDown}
            placeholder="https://example.com/image.png"
            onMouseDown={e => e.stopPropagation()}
          />
          <div className="amby-block-panel-url-actions">
            <button type="button" onClick={() => setMode("list")}>
              Назад
            </button>
            <button type="button" className="is-primary" onClick={applyUrl}>
              Вставить
            </button>
          </div>
        </div>
      )}

      {mode === "emoji" && (
        <div className="amby-block-panel-emoji" onMouseDown={e => e.stopPropagation()}>
          <EmojiPickerPanel
            onSelect={emoji => {
              editor.chain().focus().insertContent(emoji.native).run()
              onClose()
            }}
            onClose={() => setMode("list")}
          />
        </div>
      )}
    </div>
  )
}
