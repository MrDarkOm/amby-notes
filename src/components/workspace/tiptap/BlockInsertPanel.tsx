"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import type { Editor, Range } from "@tiptap/core"
import { motion } from "motion/react"

import {
  filterBlockItems,
  getPlusItems,
  getSlashItems,
  insertDatabaseView,
  type BlockInsertItem,
  type BlockMediaContext,
} from "./block-insert-items"
import { DatabaseViewPicker } from "@/components/workspace/database/database-view-picker"
import { SLASH_MENU_KEY_EVENT, type SlashMenuKey } from "./slash-menu"
import { EmojiPickerPanel } from "./EmojiPickerPanel"
import { isTauri } from "@/lib/storage"
import { useSmartPlacement, type AnchorRect } from "./use-smart-placement"
import { motionTransitions } from "@/lib/motion-config"

type Mode = "list" | "url" | "emoji" | "database"

interface Props {
  editor: Editor
  vaultPath?: string
  notePath?: string
  /** "plus" — opened from the "+" rail. "slash" — opened from / suggestion. */
  source?: "plus" | "slash"
  /** Range to delete before applying an item (slash trigger only). */
  range?: Range
  /**
   * What was typed after the `/` in the note. The slash menu has no field of its own:
   * the text stays in the note, keeps the focus, and narrows the list as it is typed.
   */
  slashQuery?: string
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
  slashQuery,
  anchorRect,
  onClose,
}: Props) {
  const [mode, setMode] = React.useState<Mode>("list")
  const [typedQuery, setQuery] = React.useState("")
  const typesInNote = source === "slash"
  const query = typesInNote ? (slashQuery ?? "") : typedQuery
  const [active, setActive] = React.useState(0)
  const [urlValue, setUrlValue] = React.useState("")
  const searchRef = React.useRef<HTMLInputElement>(null)
  const urlRef = React.useRef<HTMLInputElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const activeRowRef = React.useRef<HTMLButtonElement>(null)
  const placementStyle = useSmartPlacement(anchorRect, panelRef)
  const { t } = useTranslation()
  const tauri = isTauri()

  const all = React.useMemo(() => (source === "slash" ? getSlashItems() : getPlusItems()), [source])

  // The list in the order it is shown: group by group, and inside a group the items
  // whose name starts with the query before those that only contain it.
  const filtered = React.useMemo(
    () =>
      filterBlockItems(
        all,
        query,
        (item) => t(`blockItems.${item.id}.title`),
        (item) => t(`blockItems.${item.id}.hint`),
      ),
    [all, query, t],
  )

  React.useLayoutEffect(() => {
    if (mode === "list") {
      // The slash menu leaves the focus in the note, where the query is typed.
      if (typesInNote) return
      searchRef.current?.focus()
      const frame = requestAnimationFrame(() => searchRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
    if (mode === "url") urlRef.current?.focus()
  }, [mode, typesInNote])

  // Typed text that matches no block is ordinary text ("a / b"): the menu gets out of
  // the way so that Enter and the arrows belong to the note again.
  React.useEffect(() => {
    if (typesInNote && mode === "list" && query.trim() && filtered.length === 0) onClose()
  }, [filtered.length, mode, onClose, query, typesInNote])

  React.useEffect(() => {
    setActive(0)
  }, [query, mode])

  // The arrows can move the choice below the fold of the list. Hovering must not
  // scroll it: the row would slide from under the pointer just before the click.
  const movedByKeyRef = React.useRef(false)
  React.useEffect(() => {
    if (!movedByKeyRef.current) return
    movedByKeyRef.current = false
    activeRowRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [active])

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

  // The slash text stays until a view is chosen: removing it would end the
  // suggestion and unmount this panel, and Escape must leave the note untouched.
  const requestDatabasePicker = React.useCallback(() => setMode("database"), [])

  const ctx = React.useMemo<BlockMediaContext>(
    () => ({
      vaultPath,
      notePath,
      requestUrlInput,
      requestEmojiPicker,
      requestDatabasePicker,
    }),
    [notePath, requestDatabasePicker, requestEmojiPicker, requestUrlInput, vaultPath],
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
      if (item.id === "image-url" || item.id === "emoji" || item.id === "database-view") {
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
    (event: SlashMenuKey): boolean => {
      if (event.key === "Escape") {
        if (mode !== "list") setMode("list")
        else onClose()
        return true
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = filtered[active]
        if (item) choose(item)
        return true
      }
      if (event.key === "ArrowDown") {
        movedByKeyRef.current = true
        if (filtered.length > 0) setActive((a) => (a + 1) % filtered.length)
        return true
      }
      if (event.key === "ArrowUp") {
        movedByKeyRef.current = true
        if (filtered.length > 0) setActive((a) => (a - 1 + filtered.length) % filtered.length)
        return true
      }
      return false
    },
    [active, choose, filtered, mode, onClose],
  )

  function onListKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLDivElement>) {
    if (handleListKey(e)) e.preventDefault()
  }

  React.useEffect(() => {
    if (source !== "slash" || mode !== "list") return
    const onSlashMenuKey = (event: Event) => {
      handleListKey((event as CustomEvent<SlashMenuKey>).detail)
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
    <motion.div
      ref={panelRef}
      className="amby-block-panel amby-block-panel--insert"
      initial={{ opacity: 0, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={motionTransitions.enter}
      data-mode={mode}
      style={placementStyle}
      onMouseDown={(e) => e.preventDefault()}
    >
      {mode === "list" && (
        <>
          {!typesInNote && (
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
          )}
          <div
            className="amby-block-panel-body"
            role="listbox"
            onKeyDown={onListKeyDown}
            tabIndex={-1}
          >
            {filtered.length === 0 ? (
              <div className="amby-block-panel-empty">{t("blockPanel.notFound")}</div>
            ) : (
              filtered.map((item, idx) => {
                const disabled = itemDisabled(item)
                const opensGroup = idx === 0 || filtered[idx - 1].category !== item.category
                return (
                  <React.Fragment key={item.id}>
                    {opensGroup && (
                      <div className="amby-block-panel-group" role="presentation">
                        {t(`blockPanel.groups.${item.category}`)}
                      </div>
                    )}
                    <motion.button
                      ref={active === idx ? activeRowRef : undefined}
                      type="button"
                      role="option"
                      aria-selected={active === idx}
                      disabled={disabled}
                      className={
                        "amby-block-row" +
                        (active === idx ? " is-active" : "") +
                        (disabled ? " is-disabled" : "")
                      }
                      onMouseEnter={() => setActive(idx)}
                      whileHover={disabled ? undefined : { x: 2 }}
                      whileTap={disabled ? undefined : { scale: 0.99 }}
                      transition={motionTransitions.fast}
                      onClick={() => choose(item)}
                    >
                      <item.icon className="amby-block-row-icon" />
                      <span className="amby-block-row-label">
                        {t(`blockItems.${item.id}.title`)}
                      </span>
                      <span className="amby-block-row-hint">{t(`blockItems.${item.id}.hint`)}</span>
                    </motion.button>
                  </React.Fragment>
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

      {mode === "database" && (
        <DatabaseViewPicker
          className="amby-block-panel-database"
          onCancel={() => setMode("list")}
          onSelect={(choice) => {
            void insertDatabaseView(editor, choice, source === "slash" ? range : undefined)
            onClose()
          }}
        />
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
    </motion.div>
  )
}
