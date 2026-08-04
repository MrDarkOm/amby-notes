"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import { ExternalLink, FilePenLine, Link2Off, Pencil, X } from "lucide-react"

import type { WikiLinkContextDetail } from "./tags-wikilinks"

interface WikiLinkContextMenuProps {
  editor: Editor
  context: WikiLinkContextDetail | null
  onNavigate: (target: string) => void
  onClose: () => void
}

type EditMode = "target" | "label" | null

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

export function WikiLinkContextMenu({
  editor,
  context,
  onNavigate,
  onClose,
}: WikiLinkContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [mode, setMode] = React.useState<EditMode>(null)
  const [draft, setDraft] = React.useState("")

  React.useEffect(() => {
    setMode(null)
    setDraft("")
  }, [context])

  React.useEffect(() => {
    if (!context) return
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [context, onClose])

  React.useEffect(() => {
    if (mode) inputRef.current?.focus()
  }, [mode])

  if (!context) return null

  const activeContext = context
  const editable = editor.isEditable
  const style = {
    left: clamp(activeContext.clientX, 8, window.innerWidth - 272),
    top: clamp(activeContext.clientY, 8, window.innerHeight - 220),
  }

  function replaceToken(next: string) {
    const { state, view } = editor
    if (
      activeContext.from < 0 ||
      activeContext.to < activeContext.from ||
      activeContext.to > state.doc.content.size
    ) {
      onClose()
      return
    }
    view.dispatch(state.tr.insertText(next, activeContext.from, activeContext.to))
    view.focus()
    onClose()
  }

  function openEditor(nextMode: Exclude<EditMode, null>) {
    setMode(nextMode)
    setDraft(nextMode === "target" ? activeContext.target : activeContext.label)
  }

  function saveEdit() {
    const value = draft.trim()
    if (!value) return
    if (mode === "target") {
      const label = activeContext.hasAlias ? activeContext.label : value
      replaceToken(`[[${value}${activeContext.hasAlias ? `|${label}` : ""}]]`)
      return
    }
    const target = activeContext.target
    replaceToken(`[[${target}|${value}]]`)
  }

  return createPortal(
    <div
      ref={menuRef}
      className="amby-wikilink-menu"
      style={style}
      role="menu"
      aria-label={t("wikiLinkMenu.actions")}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="amby-wikilink-menu-title" title={activeContext.target}>
        {activeContext.target}
      </div>

      {mode ? (
        <form
          className="amby-wikilink-menu-edit"
          onSubmit={(event) => {
            event.preventDefault()
            saveEdit()
          }}
        >
          <label>{mode === "target" ? t("wikiLinkMenu.file") : t("wikiLinkMenu.name")}</label>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                setMode(null)
              }
            }}
          />
          <div className="amby-wikilink-menu-edit-actions">
            <button type="button" onClick={() => setMode(null)}>
              {t("wikiLinkMenu.cancel")}
            </button>
            <button type="submit" className="is-primary">
              {t("wikiLinkMenu.save")}
            </button>
          </div>
        </form>
      ) : (
        <div className="amby-wikilink-menu-actions">
          <button type="button" onClick={() => onNavigate(activeContext.raw)}>
            <ExternalLink />
            {t("wikiLinkMenu.open")}
          </button>
          {editable && (
            <>
              <button type="button" onClick={() => openEditor("target")}>
                <FilePenLine />
                {t("wikiLinkMenu.changeFile")}
              </button>
              <button type="button" onClick={() => openEditor("label")}>
                <Pencil />
                {t("wikiLinkMenu.rename")}
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => replaceToken(activeContext.label)}
              >
                <Link2Off />
                {t("wikiLinkMenu.removeLink")}
              </button>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className="amby-wikilink-menu-close"
        onClick={onClose}
        aria-label={t("wikiLinkMenu.close")}
      >
        <X />
      </button>
    </div>,
    document.body,
  )
}
