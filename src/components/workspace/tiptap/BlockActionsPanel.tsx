"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronRight,
  Copy,
  Droplet,
  Link as LinkIcon,
  List,
  ListOrdered,
  Rows3,
  Trash2,
} from "lucide-react"

import { getTurnIntoItems, type BlockInsertItem } from "./block-insert-items"
import { CALLOUT_DEFAULTS } from "./callout-node"
import { importAsset, pickAssetFile } from "@/lib/storage"
import { useSmartPlacement, type AnchorRect } from "./use-smart-placement"
import { BLOCK_TEXT_COLORS as TEXT_COLORS, CALLOUT_SWATCHES } from "@/lib/themes"

interface Props {
  editor: Editor
  nodePos: number
  nodeType: string
  isCallout: boolean
  vaultPath?: string
  notePath?: string
  anchorRect: AnchorRect
  onDuplicate: () => void
  onDelete: () => void
  onInsertAbove: () => void
  onInsertBelow: () => void
  onFocusInsideBlock: () => void
  onClose: () => void
}

const CALLOUT_TYPES = Object.keys(CALLOUT_DEFAULTS) as Array<keyof typeof CALLOUT_DEFAULTS>

/**
 * Turns the visual lines in one paragraph into sibling paragraph blocks while
 * preserving inline marks and inline nodes. This is deliberately a separate
 * action from "Turn into": a paragraph stays a paragraph.
 */
function splitParagraphIntoBlocks(editor: Editor, nodePos: number): boolean {
  const paragraph = editor.state.doc.nodeAt(nodePos)
  if (!paragraph || paragraph.type.name !== "paragraph") return false

  const lines: PMNode[][] = [[]]
  const nextLine = () => lines.push([])
  const appendToCurrentLine = (child: PMNode) => {
    lines[lines.length - 1]?.push(child)
  }

  paragraph.forEach((child) => {
    if (child.type.name === "hardBreak") {
      nextLine()
      return
    }

    if (!child.isText || !child.text?.includes("\n")) {
      appendToCurrentLine(child)
      return
    }

    const parts = child.text.split(/\r?\n/u)
    parts.forEach((part, index) => {
      if (part) appendToCurrentLine(paragraph.type.schema.text(part, child.marks))
      if (index < parts.length - 1) nextLine()
    })
  })

  if (lines.length < 2) return false

  const paragraphs = lines.map((line) =>
    paragraph.type.create(paragraph.attrs, Fragment.fromArray(line)),
  )
  const transaction = editor.state.tr
    .replaceWith(nodePos, nodePos + paragraph.nodeSize, Fragment.fromArray(paragraphs))
    .scrollIntoView()

  editor.view.dispatch(transaction)
  editor.commands.focus()
  return true
}

export function BlockActionsPanel({
  editor,
  nodePos,
  nodeType,
  isCallout,
  vaultPath,
  notePath,
  anchorRect,
  onDuplicate,
  onDelete,
  onInsertAbove,
  onInsertBelow,
  onFocusInsideBlock,
  onClose,
}: Props) {
  const [query, setQuery] = React.useState("")
  const [turnIntoOpen, setTurnIntoOpen] = React.useState(false)
  const [turnIntoAnchor, setTurnIntoAnchor] = React.useState<AnchorRect | null>(null)
  const { t } = useTranslation()
  const turnIntoBtnRef = React.useRef<HTMLButtonElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const placementStyle = useSmartPlacement(anchorRect, panelRef)

  React.useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const matches = React.useCallback(
    (s: string) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return s.toLowerCase().includes(q)
    },
    [query],
  )

  const turnIntoItems = React.useMemo(() => getTurnIntoItems(), [])
  const canSplitParagraph = React.useMemo(() => {
    const paragraph = nodeType === "paragraph" ? editor.state.doc.nodeAt(nodePos) : null
    if (!paragraph) return false
    let hasLineBreak = false
    paragraph.forEach((child) => {
      if (child.type.name === "hardBreak" || child.text?.includes("\n")) hasLineBreak = true
    })
    return hasLineBreak
  }, [editor, nodePos, nodeType])
  // Multi-line paragraphs can be separated first; a regular one-line text
  // block has the same Turn into affordance as headings and other blocks.
  const canTurnInto = nodeType !== "paragraph" || !canSplitParagraph
  const turnIntoVisible =
    canTurnInto &&
    (matches(t("blockPanel.turnInto")) ||
      turnIntoItems.some((i) => matches(t(`blockItems.${i.id}.title`))))
  const splitVisible =
    canSplitParagraph && (matches("split") || matches("разделить") || matches("block"))
  const insertVisible = matches("insert") || matches("вставить")

  function chooseTurnInto(item: BlockInsertItem) {
    onFocusInsideBlock()
    void item.inline(editor)
    setTurnIntoOpen(false)
    onClose()
  }

  const isListItem = nodeType === "listItem" || nodeType === "taskItem"
  const hasContext =
    nodeType === "callout" ||
    nodeType === "heading" ||
    nodeType === "image" ||
    nodeType === "codeBlock" ||
    isListItem

  return (
    <div
      ref={panelRef}
      className="amby-block-panel amby-block-panel--actions"
      style={placementStyle}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="amby-block-panel-header">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("blockPanel.searchActions")}
          className="amby-block-panel-search"
        />
      </div>

      <div className="amby-block-panel-body">
        {hasContext && (
          <>
            {isCallout && <CalloutContext editor={editor} nodePos={nodePos} matches={matches} />}
            {nodeType === "heading" && (
              <HeadingContext editor={editor} nodePos={nodePos} matches={matches} />
            )}
            {nodeType === "image" && (
              <ImageContext
                editor={editor}
                nodePos={nodePos}
                vaultPath={vaultPath}
                notePath={notePath}
                matches={matches}
              />
            )}
            {nodeType === "codeBlock" && (
              <CodeBlockContext editor={editor} nodePos={nodePos} matches={matches} />
            )}
            {isListItem && <ListContext editor={editor} nodePos={nodePos} matches={matches} />}
          </>
        )}
        {!hasContext &&
          !splitVisible &&
          !turnIntoVisible &&
          matches("duplicate") === false &&
          matches("delete") === false && (
            <div className="amby-block-panel-empty">{t("blockPanel.noSettings")}</div>
          )}
      </div>

      <div className="amby-block-panel-footer">
        {insertVisible && (
          <>
            <button type="button" className="amby-block-row" onClick={onInsertAbove}>
              <ArrowUp className="amby-block-row-icon" />
              <span className="amby-block-row-label">{t("blockPanel.insertAbove")}</span>
            </button>
            <button type="button" className="amby-block-row" onClick={onInsertBelow}>
              <ArrowDown className="amby-block-row-icon" />
              <span className="amby-block-row-label">{t("blockPanel.insertBelow")}</span>
            </button>
          </>
        )}
        {turnIntoVisible && (
          <button
            ref={turnIntoBtnRef}
            type="button"
            className="amby-block-row"
            onClick={() => {
              const rect = turnIntoBtnRef.current?.getBoundingClientRect()
              if (rect) {
                setTurnIntoAnchor({
                  left: rect.right + 4,
                  top: rect.top,
                  right: rect.right + 4,
                  bottom: rect.bottom,
                  width: 0,
                  height: rect.height,
                })
              }
              setTurnIntoOpen((v) => !v)
            }}
          >
            <ChevronRight className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.turnInto")}</span>
            <span className="amby-block-row-hint">▸</span>
          </button>
        )}
        {splitVisible && (
          <button
            type="button"
            className="amby-block-row"
            onClick={() => {
              if (splitParagraphIntoBlocks(editor, nodePos)) onClose()
            }}
          >
            <Rows3 className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.splitBlocks")}</span>
          </button>
        )}
        {matches("copy link") && (
          <button
            type="button"
            className="amby-block-row is-disabled"
            title={t("common.comingSoon")}
            disabled
          >
            <LinkIcon className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.copyLink")}</span>
            <span className="amby-block-row-hint">⌘L</span>
          </button>
        )}
        {matches("duplicate") && (
          <button type="button" className="amby-block-row" onClick={onDuplicate}>
            <Copy className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.duplicate")}</span>
            <span className="amby-block-row-hint">⌘D</span>
          </button>
        )}
        {matches("delete") && (
          <button type="button" className="amby-block-row is-danger" onClick={onDelete}>
            <Trash2 className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.delete")}</span>
            <span className="amby-block-row-hint">⌫</span>
          </button>
        )}
      </div>
      {turnIntoOpen && turnIntoAnchor && (
        <TurnIntoMenu
          anchorRect={turnIntoAnchor}
          items={turnIntoItems.filter((i) => matches(t(`blockItems.${i.id}.title`)))}
          onChoose={chooseTurnInto}
        />
      )}
    </div>
  )
}

// ── Turn-into popover ────────────────────────────────────────────────────────

function TurnIntoMenu({
  anchorRect,
  items,
  onChoose,
}: {
  anchorRect: AnchorRect
  items: BlockInsertItem[]
  onChoose: (item: BlockInsertItem) => void
}) {
  const { t } = useTranslation()
  const ref = React.useRef<HTMLDivElement>(null)
  const style = useSmartPlacement(anchorRect, ref)
  return createPortal(
    <div
      ref={ref}
      className="amby-turn-into-menu"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="amby-block-row"
          onClick={() => onChoose(item)}
        >
          <item.icon className="amby-block-row-icon" />
          <span className="amby-block-row-label">{t(`blockItems.${item.id}.title`)}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

// ── Context: Callout ─────────────────────────────────────────────────────────

function CalloutContext({
  editor,
  nodePos,
  matches,
}: {
  editor: Editor
  nodePos: number
  matches: (s: string) => boolean
}) {
  const { t } = useTranslation()
  const node = editor.state.doc.nodeAt(nodePos)
  const calloutType = (node?.attrs.calloutType as string) ?? "NOTE"

  function setBg(id: string) {
    editor
      .chain()
      .focus()
      .updateAttributes("callout", { bgColor: id === "none" ? null : id })
      .run()
  }

  function setType(t: keyof typeof CALLOUT_DEFAULTS) {
    editor
      .chain()
      .focus()
      .updateAttributes("callout", { calloutType: t, emoji: CALLOUT_DEFAULTS[t] })
      .run()
  }

  function setTextColor(color: string | null) {
    if (!node) return
    const end = nodePos + node.nodeSize
    editor
      .chain()
      .focus()
      .setTextSelection({ from: nodePos + 1, to: end - 1 })
      .setAmbyTextStyle({ color })
      .run()
  }

  const showBg = matches("background") || matches("фон") || matches("color")
  const showText = matches("text color") || matches("color") || matches("текст")
  const showType =
    matches("type") || matches("emoji") || matches("тип") || matches("note") || matches("warning")

  if (!showBg && !showText && !showType) return null

  return (
    <>
      {showBg && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.bgCallout")}</div>
          <div className="amby-ctx-swatches">
            {CALLOUT_SWATCHES.map((sw) => (
              <button
                key={sw.id}
                type="button"
                title={t(`colors.${sw.id}`)}
                className={
                  sw.id === "none" ? "amby-ctx-swatch amby-ctx-swatch--none" : "amby-ctx-swatch"
                }
                style={sw.color ? { background: sw.color } : undefined}
                onClick={() => setBg(sw.id)}
              >
                {sw.id === "none" && <Droplet className="size-3" />}
              </button>
            ))}
          </div>
        </>
      )}
      {showText && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.textColor")}</div>
          <div className="amby-ctx-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.id}
                className={
                  c.color == null ? "amby-ctx-swatch amby-ctx-swatch--none" : "amby-ctx-swatch"
                }
                style={c.color ? { background: c.color } : undefined}
                onClick={() => setTextColor(c.color)}
              >
                {c.color == null && <Droplet className="size-3" />}
              </button>
            ))}
          </div>
        </>
      )}
      {showType && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.type")}</div>
          <div className="amby-ctx-type-grid">
            {CALLOUT_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                title={t}
                className={"amby-ctx-type-btn" + (t === calloutType ? " is-active" : "")}
                onClick={() => setType(t)}
              >
                {CALLOUT_DEFAULTS[t]}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ── Context: Heading ─────────────────────────────────────────────────────────

function HeadingContext({
  editor,
  nodePos,
  matches,
}: {
  editor: Editor
  nodePos: number
  matches: (s: string) => boolean
}) {
  const { t } = useTranslation()
  const node = editor.state.doc.nodeAt(nodePos)
  const currentLevel = (node?.attrs.level as number) ?? 1

  if (
    !matches("heading") &&
    !matches("уровень") &&
    !matches("level") &&
    !matches("h1") &&
    !matches("h2") &&
    !matches("h3") &&
    !matches("h4") &&
    !matches("h5")
  ) {
    return null
  }

  function setLevel(level: 1 | 2 | 3 | 4 | 5) {
    editor
      .chain()
      .focus()
      .setTextSelection(nodePos + 1)
      .setHeading({ level })
      .run()
  }

  return (
    <>
      <div className="amby-block-panel-section">{t("blockPanel.headingLevel")}</div>
      <div className="amby-ctx-heading-grid">
        {([1, 2, 3, 4, 5] as const).map((level) => (
          <button
            key={level}
            type="button"
            className={"amby-ctx-heading-btn" + (level === currentLevel ? " is-active" : "")}
            onClick={() => setLevel(level)}
          >
            H{level}
          </button>
        ))}
      </div>
    </>
  )
}

// ── Context: Image ───────────────────────────────────────────────────────────

function ImageContext({
  editor,
  nodePos,
  vaultPath,
  notePath,
  matches,
}: {
  editor: Editor
  nodePos: number
  vaultPath?: string
  notePath?: string
  matches: (s: string) => boolean
}) {
  const { t } = useTranslation()
  const node = editor.state.doc.nodeAt(nodePos)
  const altInit = (node?.attrs.alt as string | null) ?? ""
  const alignInit = (node?.attrs.align as string | null) ?? null
  const [alt, setAlt] = React.useState(altInit)
  const alignButtons = [
    { id: "left", Icon: AlignLeft },
    { id: "center", Icon: AlignCenter },
    { id: "right", Icon: AlignRight },
  ] as const

  React.useEffect(() => {
    setAlt(altInit)
    // intentionally re-run when nodePos changes (different image selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodePos])

  async function replaceImage() {
    if (!vaultPath || !notePath) return
    const src = await pickAssetFile(true)
    if (!src) return
    const result = await importAsset(vaultPath, notePath, src)
    if (!result) return
    editor.chain().focus().updateAttributes("image", { src: result.relPath }).run()
  }

  function commitAlt() {
    editor.chain().focus().updateAttributes("image", { alt }).run()
  }

  function setAlign(align: string) {
    editor.chain().focus().updateAttributes("image", { align }).run()
  }

  const showReplace = matches("replace") || matches("заменить")
  const showAlt = matches("alt")
  const showAlign = matches("align") || matches("выравн")

  if (!showReplace && !showAlt && !showAlign) return null

  return (
    <>
      {showReplace && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.source")}</div>
          <button type="button" className="amby-ctx-replace-btn" onClick={replaceImage}>
            {t("blockPanel.replaceImage")}
          </button>
        </>
      )}
      {showAlt && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.altText")}</div>
          <input
            className="amby-ctx-text-input"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            onBlur={commitAlt}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commitAlt()
              }
            }}
            placeholder={t("blockPanel.imagePlaceholder")}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </>
      )}
      {showAlign && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.align")}</div>
          <div className="amby-ctx-align-row">
            {alignButtons.map(({ id, Icon }) => (
              <button
                key={id}
                type="button"
                className={"amby-ctx-align-btn" + (alignInit === id ? " is-active" : "")}
                onClick={() => setAlign(id)}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ── Context: List ────────────────────────────────────────────────────────────

type ListParent = {
  type: "bulletList" | "orderedList" | "taskList"
  pos: number
  node: PMNode
}

function findListParent(editor: Editor, pos: number): ListParent | null {
  const doc = editor.state.doc
  const inside = Math.min(pos + 1, doc.content.size - 1)
  if (inside < 0) return null
  const $pos = doc.resolve(inside)
  for (let d = $pos.depth; d >= 0; d--) {
    const n = $pos.node(d)
    const name = n.type.name
    if (name === "bulletList" || name === "orderedList" || name === "taskList") {
      return { type: name, pos: $pos.before(d), node: n }
    }
  }
  return null
}

function ListContext({
  editor,
  nodePos,
  matches,
}: {
  editor: Editor
  nodePos: number
  matches: (s: string) => boolean
}) {
  const { t } = useTranslation()
  const parent = findListParent(editor, nodePos)
  const parentType = parent?.type ?? null

  function switchTo(target: "bullet" | "ordered" | "task") {
    const same =
      (target === "bullet" && parentType === "bulletList") ||
      (target === "ordered" && parentType === "orderedList") ||
      (target === "task" && parentType === "taskList")
    if (same || !parent) return

    const listType =
      editor.schema.nodes[
        target === "bullet" ? "bulletList" : target === "ordered" ? "orderedList" : "taskList"
      ]
    const itemType = editor.schema.nodes[target === "task" ? "taskItem" : "listItem"]
    if (!listType || !itemType) return

    const items: PMNode[] = []
    parent.node.forEach((item) => {
      items.push(
        itemType.create(target === "task" ? { checked: false } : null, item.content, item.marks),
      )
    })
    const replacement = listType.create(
      target === "ordered" ? { start: 1 } : null,
      Fragment.fromArray(items),
    )
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(parent.pos, parent.pos + parent.node.nodeSize, replacement)
        .scrollIntoView(),
    )
    editor.commands.focus()
  }

  if (
    !matches("list") &&
    !matches("список") &&
    !matches("bullet") &&
    !matches("ordered") &&
    !matches("task") &&
    !matches("тип")
  ) {
    return null
  }

  const buttons = [
    {
      id: "bullet",
      label: t("blockPanel.bulletList"),
      Icon: List,
      active: parentType === "bulletList",
    },
    {
      id: "ordered",
      label: t("blockPanel.orderedList"),
      Icon: ListOrdered,
      active: parentType === "orderedList",
    },
    {
      id: "task",
      label: t("blockPanel.taskList"),
      Icon: CheckSquare,
      active: parentType === "taskList",
    },
  ] as const

  return (
    <>
      <div className="amby-block-panel-section">{t("blockPanel.listType")}</div>
      <div className="amby-ctx-align-row">
        {buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            title={b.label}
            className={"amby-ctx-align-btn" + (b.active ? " is-active" : "")}
            onClick={() => switchTo(b.id)}
          >
            <b.Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </>
  )
}

// ── Context: CodeBlock ───────────────────────────────────────────────────────

function CodeBlockContext({
  editor,
  nodePos,
  matches,
}: {
  editor: Editor
  nodePos: number
  matches: (s: string) => boolean
}) {
  const { t } = useTranslation()
  const node = editor.state.doc.nodeAt(nodePos)
  const initial = (node?.attrs.language as string | null) ?? ""
  const [lang, setLang] = React.useState(initial)

  React.useEffect(() => {
    setLang(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodePos])

  function commit() {
    editor
      .chain()
      .focus()
      .updateAttributes("codeBlock", { language: lang.trim() || null })
      .run()
  }

  if (!matches("language") && !matches("язык") && !matches("code")) return null

  return (
    <>
      <div className="amby-block-panel-section">{t("blockPanel.codeLanguage")}</div>
      <input
        className="amby-ctx-text-input"
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        placeholder={t("blockPanel.codeLanguagePlaceholder")}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </>
  )
}
