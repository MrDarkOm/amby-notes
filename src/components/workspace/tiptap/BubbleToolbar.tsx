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
  Smile,
  Strikethrough,
  Underline,
} from "lucide-react"

import { EMOJIS } from "./constants"
import { markdownToDoc } from "./markdown"
import { TextStylePalette } from "../text-style-palette"

type Panel = "heading" | "color" | "list" | "emoji" | null

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

  function togglePanel(next: Exclude<Panel, null>) {
    setPanel(prev => (prev === next ? null : next))
  }

  function setHeading(level: 1 | 2 | 3 | 4 | 5 | null) {
    if (level === null) editor.chain().focus().setParagraph().run()
    else editor.chain().focus().setHeading({ level }).run()
    setPanel(null)
  }

  function applyTextColor(color: string | null) {
    editor.chain().focus().setAmbyTextStyle({ color }).run()
  }

  function applyBackgroundColor(color: string | null) {
    editor.chain().focus().setAmbyTextStyle({ backgroundColor: color }).run()
  }

  function insertTag() {
    const tag = window.prompt("Tag", "tag")
    if (!tag) return
    editor.chain().focus().insertContent(`#${tag.replace(/^#/, "").trim()} `).run()
  }

  function insertLink() {
    const url = window.prompt("URL")
    if (!url) return
    const { empty } = editor.state.selection
    if (empty) {
      const label = window.prompt("Текст ссылки", url) ?? url
      editor.chain().focus().insertContent(`[${label}](${url})`).run()
      return
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
  }

  function insertWikiLink() {
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, " ").trim()
    const target = window.prompt("Backlink", selected || "Note")
    if (!target) return
    editor.chain().focus().insertContent(`[[${target}]]`).run()
  }

  function insertCallout() {
    const { from, to, empty } = editor.state.selection
    const selected = empty ? "" : editor.state.doc.textBetween(from, to, "\n")
    const body = selected
      ? `> [!NOTE]\n${selected.split("\n").map(line => `> ${line}`).join("\n")}`
      : "> [!NOTE]\n> "
    const doc = markdownToDoc(body) as { content?: unknown }
    editor.chain().focus().insertContent((doc.content as object) ?? body).run()
  }

  function insertEmoji(emoji: string) {
    editor.chain().focus().insertContent(emoji).run()
    setPanel(null)
  }

  return (
    <div
      className="amby-floating-menu fixed z-50 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-950/95 p-1 shadow-xl backdrop-blur"
      style={{ left, top }}
      onMouseDown={e => e.preventDefault()}
    >
      <ToolbarButton title="Заголовок" active={panel === "heading"} onClick={() => togglePanel("heading")}>
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

      <div className="mx-1 h-5 w-px bg-zinc-800" />

      <ToolbarButton title="Цвет" active={panel === "color"} onClick={() => togglePanel("color")}>
        <Palette className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Тег" onClick={insertTag}>
        <Hash className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="URL link" onClick={insertLink}>
        <Link className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Backlink" onClick={insertWikiLink}>
        <span className="text-[10px] font-semibold">[[</span>
      </ToolbarButton>
      <ToolbarButton title="Emoji" active={panel === "emoji"} onClick={() => togglePanel("emoji")}>
        <Smile className="size-3.5" />
      </ToolbarButton>

      <div className="mx-1 h-5 w-px bg-zinc-800" />

      <ToolbarButton title="List" active={panel === "list"} onClick={() => togglePanel("list")}>
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

      {panel && (
        <div className="absolute left-0 top-[calc(100%+6px)] rounded-md border border-zinc-800 bg-zinc-950/98 p-1 shadow-xl">
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
          {panel === "color" && (
            <TextStylePalette
              onTextColor={color => applyTextColor(color)}
              onBackgroundColor={color => applyBackgroundColor(color)}
              onClearTextColor={() => applyTextColor(null)}
              onClearBackgroundColor={() => applyBackgroundColor(null)}
            />
          )}
          {panel === "list" && (
            <div className="flex items-center gap-1">
              <ToolbarButton
                title="Bullet list"
                onClick={() => {
                  editor.chain().focus().toggleBulletList().run()
                  setPanel(null)
                }}
              >
                <List className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Ordered list"
                onClick={() => {
                  editor.chain().focus().toggleOrderedList().run()
                  setPanel(null)
                }}
              >
                <ListOrdered className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton
                title="Task list"
                onClick={() => {
                  editor.chain().focus().toggleTaskList().run()
                  setPanel(null)
                }}
              >
                <CheckSquare className="size-3.5" />
              </ToolbarButton>
            </div>
          )}
          {panel === "emoji" && (
            <div className="grid grid-cols-6 gap-1">
              {EMOJIS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="flex size-8 items-center justify-center rounded text-base hover:bg-zinc-800"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => insertEmoji(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
