"use client"

import * as React from "react"
import type { Editor } from "@tiptap/react"
import {
  Bold,
  CheckSquare,
  Code2,
  Hash,
  Heading,
  Italic,
  Link,
  List,
  ListOrdered,
  MessageSquare,
  Palette,
  Pilcrow,
  Quote,
  Strikethrough,
  Underline,
} from "lucide-react"

import { TextStylePalette } from "../text-style-palette"
import { CALLOUT_DEFAULTS } from "./callout-node"
import { wrapSelectionInCallout } from "./block-insert-items"

type Panel = "heading" | "color" | "list" | "tag" | "link" | "wikilink" | null

interface BubbleToolbarProps {
  editor: Editor
  left: number
  top: number
}

function ToolbarButton({
  title,
  active,
  children,
  onClick,
}: {
  title: string
  active?: boolean
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      className={`flex size-7 items-center justify-center rounded transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      }`}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const HEADINGS: Array<{ label: string; level: 1 | 2 | 3 | 4 | 5 | null; Icon?: React.ElementType }> = [
  { label: "P", level: null, Icon: Pilcrow },
  { label: "H1", level: 1 },
  { label: "H2", level: 2 },
  { label: "H3", level: 3 },
  { label: "H4", level: 4 },
  { label: "H5", level: 5 },
]

export function BubbleToolbar({ editor, left, top }: BubbleToolbarProps) {
  const [panel, setPanel] = React.useState<Panel>(null)
  const [inputValue, setInputValue] = React.useState("")
  const [linkLabel, setLinkLabel] = React.useState("")
  // Track whether selection was empty when the link panel was opened.
  const [linkHasSelection, setLinkHasSelection] = React.useState(false)

  function openPanel(next: Exclude<Panel, null>) {
    setInputValue("")
    setLinkLabel("")
    setPanel(prev => (prev === next ? null : next))
  }

  function closePanel() {
    setPanel(null)
    setInputValue("")
    setLinkLabel("")
  }

  function setHeading(level: 1 | 2 | 3 | 4 | 5 | null) {
    if (level === null) editor.chain().focus().setParagraph().run()
    else editor.chain().focus().setHeading({ level }).run()
    closePanel()
  }

  function applyTextColor(color: string | null) {
    editor.chain().focus().setAmbyTextStyle({ color }).run()
  }

  function applyBackgroundColor(color: string | null) {
    editor.chain().focus().setAmbyTextStyle({ backgroundColor: color }).run()
  }

  // ── Tag panel ──────────────────────────────────────────────────────────────
  function openTagPanel() {
    const { from, to } = editor.state.selection
    if (from !== to) {
      // Selection exists: wrap immediately without opening the input panel
      const selected = editor.state.doc.textBetween(from, to, " ").trim()
      const slug = selected.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "")
      if (slug) {
        editor.chain().focus().insertContentAt({ from, to }, `#${slug} `).run()
        return
      }
    }
    setInputValue("")
    setPanel("tag")
  }

  function applyTag() {
    const tag = inputValue.replace(/^#/, "").trim()
    if (!tag) return
    editor.chain().focus().insertContent(`#${tag} `).run()
  }

  // ── Link panel ─────────────────────────────────────────────────────────────
  function openLinkPanel() {
    const isEmpty = editor.state.selection.empty
    setLinkHasSelection(!isEmpty)
    setInputValue("")
    setLinkLabel("")
    setPanel("link")
  }

  function applyLink() {
    const url = inputValue.trim()
    if (!url) return
    if (!linkHasSelection) {
      const label = linkLabel.trim() || url
      editor.chain().focus().insertContent(`[${label}](${url})`).run()
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
    }
  }

  // ── Wikilink panel ─────────────────────────────────────────────────────────
  function openWikilinkPanel() {
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, " ").trim()
    if (from !== to && selected) {
      // Selection exists: wrap immediately as [[selected text]]
      editor.chain().focus().insertContentAt({ from, to }, `[[${selected}]]`).run()
      return
    }
    setInputValue(selected)
    setPanel("wikilink")
  }

  function applyWikilink() {
    const target = inputValue.trim()
    if (!target) return
    editor.chain().focus().insertContent(`[[${target}]]`).run()
  }

  // ── Callout ────────────────────────────────────────────────────────────────
  function insertCallout() {
    const { from, to } = editor.state.selection
    if (from !== to) {
      // Selection exists: wrap the selected block(s) in a callout
      wrapSelectionInCallout(editor)
      return
    }
    editor.chain().focus().insertContent({
      type: "callout",
      attrs: { calloutType: "NOTE", emoji: CALLOUT_DEFAULTS.NOTE },
      content: [{ type: "paragraph" }],
    }).run()
  }

  // Shared input key handler
  function handleInputKey(
    e: React.KeyboardEvent<HTMLInputElement>,
    onEnter: () => void
  ) {
    if (e.key === "Enter") {
      e.preventDefault()
      onEnter()
      closePanel()
    }
    if (e.key === "Escape") closePanel()
  }

  return (
    <div
      className="amby-floating-menu fixed z-50 flex items-center gap-1 rounded-md border border-zinc-700 bg-black p-1 shadow-xl backdrop-blur"
      style={{ left, top }}
      onMouseDown={e => {
        // Prevent editor blur when clicking toolbar buttons; allow it for
        // <input> elements so they can receive focus naturally.
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
      }}
    >
      <ToolbarButton title="Заголовок" active={panel === "heading"} onClick={() => openPanel("heading")}>
        <Heading className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        active={editor.isActive("ambyUnderline")}
        onClick={() => editor.chain().focus().toggleAmbyUnderline().run()}
      >
        <Underline className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Strike"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Code"
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code2 className="size-3.5" />
      </ToolbarButton>

      <ToolbarButton title="List" active={panel === "list"} onClick={() => openPanel("list")}>
        <List className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Callout" onClick={insertCallout}>
        <MessageSquare className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-5 w-px bg-zinc-800" />

      <ToolbarButton title="Тег" active={panel === "tag"} onClick={openTagPanel}>
        <Hash className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Backlink" active={panel === "wikilink"} onClick={openWikilinkPanel}>
        <span className="text-[10px] font-semibold">[[</span>
      </ToolbarButton>
      <ToolbarButton title="URL link" active={panel === "link"} onClick={openLinkPanel}>
        <Link className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-5 w-px bg-zinc-800" />

      <ToolbarButton title="Цвет" active={panel === "color"} onClick={() => openPanel("color")}>
        <Palette className="size-3.5" />
      </ToolbarButton>

      {panel && (
        <div className="absolute left-0 top-[calc(100%+6px)] rounded-md border border-zinc-800 bg-black p-1 shadow-xl">
          {/* ── Heading picker ─────────────────────────────────────────────── */}
          {panel === "heading" && (
            <div className="grid grid-cols-3 gap-1">
              {HEADINGS.map(({ label, level, Icon }) => (
                <button
                  key={label}
                  type="button"
                  className="flex h-8 min-w-10 items-center justify-center rounded px-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setHeading(level)}
                >
                  {Icon ? <Icon className="size-3.5" /> : label}
                </button>
              ))}
            </div>
          )}

          {/* ── Color palette ───────────────────────────────────────────────── */}
          {panel === "color" && (
            <TextStylePalette
              onTextColor={color => applyTextColor(color)}
              onBackgroundColor={color => applyBackgroundColor(color)}
              onClearTextColor={() => applyTextColor(null)}
              onClearBackgroundColor={() => applyBackgroundColor(null)}
            />
          )}

          {/* ── List type picker ────────────────────────────────────────────── */}
          {panel === "list" && (
            <div className="flex items-center gap-1">
              <ToolbarButton
                title="Bullet list"
                onClick={() => {
                  editor.chain().focus().toggleBulletList().run()
                  closePanel()
                }}
              >
                <List className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Ordered list"
                onClick={() => {
                  editor.chain().focus().toggleOrderedList().run()
                  closePanel()
                }}
              >
                <ListOrdered className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Task list"
                onClick={() => {
                  editor.chain().focus().toggleTaskList().run()
                  closePanel()
                }}
              >
                <CheckSquare className="size-3.5" />
              </ToolbarButton>
            </div>
          )}

          {/* ── Tag input ───────────────────────────────────────────────────── */}
          {panel === "tag" && (
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <span className="text-xs text-zinc-500">#</span>
              <input
                autoFocus
                type="text"
                className="w-40 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                placeholder="tagname"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => handleInputKey(e, applyTag)}
                onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
              />
            </div>
          )}

          {/* ── Link input ──────────────────────────────────────────────────── */}
          {panel === "link" && (
            <div className="flex flex-col gap-1 px-1.5 py-1">
              <div className="flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-[10px] text-zinc-500">URL</span>
                <input
                  autoFocus
                  type="url"
                  className="w-48 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                  placeholder="https://..."
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={e => handleInputKey(e, applyLink)}
                  onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
                />
              </div>
              {!linkHasSelection && (
                <div className="flex items-center gap-1.5">
                  <span className="w-8 shrink-0 text-[10px] text-zinc-500">Text</span>
                  <input
                    type="text"
                    className="w-48 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                    placeholder="Link label"
                    value={linkLabel}
                    onChange={e => setLinkLabel(e.target.value)}
                    onKeyDown={e => handleInputKey(e, applyLink)}
                    onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
                  />
                </div>
              )}
              <p className="text-[10px] text-zinc-600">Enter to confirm · Esc to cancel</p>
            </div>
          )}

          {/* ── Wikilink input ──────────────────────────────────────────────── */}
          {panel === "wikilink" && (
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <span className="text-[10px] text-zinc-500">[[</span>
              <input
                autoFocus
                type="text"
                className="w-44 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                placeholder="Note name"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => handleInputKey(e, applyWikilink)}
                onMouseDown={e => e.stopPropagation() /* let focus transfer; outer guard handles blur */}
              />
              <span className="text-[10px] text-zinc-500">]]</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
