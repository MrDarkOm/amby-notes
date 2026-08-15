"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import type { Editor, Range } from "@tiptap/core"

import {
  getPlusItems,
  getSlashItems,
  type BlockInsertItem,
  type BlockMediaContext,
} from "./block-insert-items"
import { SLASH_MENU_KEY_EVENT, type SlashMenuKey } from "./slash-menu"
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
  const { t } = useTranslation()
  const tauri = isTauri()

  const all = React.useMemo(() => (source === "slash" ? getSlashItems() : getPlusItems()), [source])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? all.filter((i) =>
          `${i.id} ${i.shortcut ?? ""} ${t(`blockItems.${i.id}.title`)} ${t(`blockItems.${i.id}.hint`)}`
            .toLowerCase()
            .includes(q),
        )
      : all
    return list
  }, [all, query, t])

  React.useLayoutEffect(() => {
    if (mode === "list") {
      searchRef.current?.focus()
      // Tiptap can restore its selection just after a suggestion opens. Focus
      // once more on the next frame so the first query character reaches here.
      const frame = requestAnimationFrame(() => searchRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
    if (mode === "url") urlRef.current?.focus()
  }, [mode])

  React.useEffect(() => {
    setActive(0)
  }, [query, mode])

  const maybeDeleteSlashRange = React.useCallback(() => {
    if (source === "slash" && range) {
      editor.chain().focus().deleteRange(range).run()
    }
  }, [editor, range, source])

  const requestUrlInput = React.useCallback(() => {
    maybeDeleteSlashRange()
    setUrlValue("")
    setMode("url")
  }, [maybeDeleteSlashRange])

  const requestEmojiPicker = React.useCallback(() => {
    maybeDeleteSlashRange()
    setMode("emoji")
  }, [maybeDeleteSlashRange])

  const ctx = React.useMemo<BlockMediaContext>(
    () => ({
      vaultPath,
      notePath,
      requestUrlInput,
      requestEmojiPicker,
    }),
    [notePath, requestEmojiPicker, requestUrlInput, vaultPath],
  )

  const itemDisabled = React.useCallback(
    (item: BlockInsertItem): boolean => {
      if (item.category !== "media") return false
      if (item.id === "image-url") return false
      if (item.id === "emoji") return false
      return !tauri
    },
    [tauri],
  )

  const choose = React.useCallback(
    (item: BlockInsertItem) => {
      if (itemDisabled(item)) return
      if (item.id === "image-url" || item.id === "emoji") {
        // These items take over the panel; no slash-range delete yet (they may bail).
        void item.inline(editor, ctx)
        return
      }
      maybeDeleteSlashRange()
      void item.inline(editor, ctx)
      onClose()
    },
    [ctx, editor, itemDisabled, maybeDeleteSlashRange, onClose],
  )

  function applyUrl() {
    const url = urlValue.trim()
    if (!url) return
    editor
      .chain()
      .focus()
      .insertContent({ type: "image", attrs: { src: url } })
      .run()
    onClose()
  }

  const handleListKey = React.useCallback(
    (event: SlashMenuKey, captureText = false): boolean => {
      if (event.key === "Escape") {
        if (mode !== "list") setMode("list")
        else onClose()
        return true
      }
      if (event.key === "Enter") {
        const item = filtered[active]
        if (item) choose(item)
        return true
      }
      if (event.key === "ArrowDown") {
        if (filtered.length > 0) setActive((a) => Math.min(a + 1, filtered.length - 1))
        return true
      }
      if (event.key === "ArrowUp") {
        if (filtered.length > 0) setActive((a) => Math.max(a - 1, 0))
        return true
      }
      if (captureText && event.key === "Backspace") {
        setQuery((value) => value.slice(0, -1))
        return true
      }
      if (
        captureText &&
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        setQuery((value) => value + event.key)
        return true
      }
      return false
    },
    [active, choose, filtered, mode, onClose],
  )

  function onListKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLDivElement>) {
    if (handleListKey(e, false)) e.preventDefault()
  }

  React.useEffect(() => {
    if (source !== "slash" || mode !== "list") return
    const onSlashMenuKey = (event: Event) => {
      handleListKey((event as CustomEvent<SlashMenuKey>).detail, true)
    }
    window.addEventListener(SLASH_MENU_KEY_EVENT, onSlashMenuKey)
    return () => window.removeEventListener(SLASH_MENU_KEY_EVENT, onSlashMenuKey)
  }, [handleListKey, mode, source])

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
      onMouseDown={(e) => e.preventDefault()}
    >
      {mode === "list" && (
        <>
          <div className="amby-block-panel-header">
            <input
              ref={searchRef}
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onListKeyDown}
              placeholder={t("blockPanel.searchPlaceholder")}
              className="amby-block-panel-search"
            />
          </div>
          <div className="amby-block-panel-body" onKeyDown={onListKeyDown} tabIndex={-1}>
            {filtered.length === 0 ? (
              <div className="amby-block-panel-empty">{t("blockPanel.notFound")}</div>
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
                    <span className="amby-block-row-label">{t(`blockItems.${item.id}.title`)}</span>
                    <span className="amby-block-row-hint">{t(`blockItems.${item.id}.hint`)}</span>
                  </button>
                )
              })
            )}
          </div>
          <div className="amby-block-panel-footer">
            <button type="button" className="amby-block-panel-close" onClick={onClose}>
              {t("blockPanel.close")}
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
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={onUrlKeyDown}
            placeholder={t("blockPanel.imageUrlPlaceholder")}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <div className="amby-block-panel-url-actions">
            <button type="button" onClick={() => setMode("list")}>
              {t("blockPanel.back")}
            </button>
            <button type="button" className="is-primary" onClick={applyUrl}>
              {t("blockPanel.insert")}
            </button>
          </div>
        </div>
      )}

      {mode === "emoji" && (
        <div className="amby-block-panel-emoji" onMouseDown={(e) => e.stopPropagation()}>
          <EmojiPickerPanel
            emojiOnly
            onSelect={(emoji) => {
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
