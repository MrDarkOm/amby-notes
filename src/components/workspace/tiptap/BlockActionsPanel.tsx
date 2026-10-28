"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { motion } from "motion/react"
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
  Captions,
  Check,
  Copy,
  Crop,
  Download,
  Droplet,
  Link as LinkIcon,
  List,
  ListOrdered,
  Maximize,
  Replace,
  RotateCcw,
  Rows3,
  Trash2,
} from "lucide-react"

import { getTurnIntoItems, type BlockInsertItem } from "./block-insert-items"
import { markActiveRow, pointerReallyMoved, revealRow, stepIndex } from "./menu-keyboard"
import { convertBlockToParagraph, convertBlockWrapper } from "./block-conversion"
import { EmojiPickerPanel } from "./EmojiPickerPanel"
import { attachmentKind, localFileKind } from "./attachment-kind"
import { isVaultImage } from "./image-actions"
import {
  canEditImageFiles,
  copyImageAt,
  imageNodeAt,
  replaceImageAt,
  requestImageCrop,
  requestImageViewer,
  saveImageAt,
} from "./image-commands"
import { updateImageNode, type ImagePatch } from "./image-edit"
import { useSmartPlacement, type AnchorRect } from "./use-smart-placement"
import { BLOCK_TEXT_COLORS as TEXT_COLORS, CALLOUT_SWATCHES } from "@/lib/themes"
import { motionTransitions } from "@/lib/motion-config"

const MotionRowButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof motion.button>
>(function MotionRowButton(props, ref) {
  return (
    <motion.button
      ref={ref}
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.99 }}
      transition={motionTransitions.fast}
      {...props}
    />
  )
})

function MotionSwatchButton(props: React.ComponentProps<typeof motion.button>) {
  return (
    <motion.button
      whileHover={{ scale: 1.1, opacity: 0.85 }}
      whileTap={{ scale: 0.95 }}
      transition={motionTransitions.fast}
      {...props}
    />
  )
}

interface Props {
  editor: Editor
  nodePos: number
  nodeType: string
  isCallout: boolean
  notePath?: string
  anchorRect: AnchorRect
  onDuplicate: () => void
  onDelete: () => void
  onInsertAbove: () => void
  onInsertBelow: () => void
  onFocusInsideBlock: () => void
  onClose: () => void
}

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
  const turnIntoMenuRef = React.useRef<HTMLDivElement>(null)
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null)
  const [active, setActive] = React.useState(0)
  const [subActive, setSubActive] = React.useState(0)
  const placementStyle = useSmartPlacement(anchorRect, panelRef)

  // The grip that opened the panel hands the focus back to the note a moment later:
  // the search field takes it again, so that typing narrows the rows.
  React.useEffect(() => {
    searchRef.current?.focus()
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  // What is typed narrows the rows: the choice starts again at the first of them.
  React.useEffect(() => {
    setActive(0)
    setSubActive(0)
  }, [query])

  const matches = React.useCallback(
    (s: string) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return s.toLowerCase().includes(q)
    },
    [query],
  )

  const turnIntoItems = React.useMemo(() => getTurnIntoItems(), [])
  const shownTurnIntoItems = turnIntoItems.filter((i) => matches(t(`blockItems.${i.id}.title`)))
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
  const insertVisible = matches(t("blockPanel.insertAbove")) || matches(t("blockPanel.insertBelow"))

  function chooseTurnInto(item: BlockInsertItem) {
    if (item.id === "paragraph") {
      if (nodeType === "listItem" || nodeType === "taskItem") {
        onFocusInsideBlock()
        editor.chain().focus().liftListItem(nodeType).setParagraph().run()
        setTurnIntoOpen(false)
        onClose()
        return
      }
      const transaction = convertBlockToParagraph(editor.state, nodePos)
      if (transaction) {
        editor.view.dispatch(transaction)
        setTurnIntoOpen(false)
        onClose()
        return
      }
    }
    if (item.id === "callout" || item.id === "blockquote") {
      const transaction = convertBlockWrapper(editor.state, nodePos, item.id)
      if (transaction) {
        editor.view.dispatch(transaction)
        setTurnIntoOpen(false)
        onClose()
        return
      }
    }
    onFocusInsideBlock()
    void item.inline(editor)
    setTurnIntoOpen(false)
    onClose()
  }

  async function copyBlockLink() {
    const node = editor.state.doc.nodeAt(nodePos)
    if (!node) return
    const noteName = (notePath ?? "").replace(/\\/gu, "/").split("/").pop()?.replace(/\.md$/iu, "")
    if (!noteName) return

    let anchor = ""
    if (node.type.name === "heading" && node.textContent.trim()) {
      anchor = `#${node.textContent.trim()}`
    } else {
      const existing = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/u.exec(node.textContent)?.[1]
      if (existing) {
        anchor = `^${existing}`
      } else {
        const blockId = `amby-${crypto.randomUUID().slice(0, 8)}`
        let insertPos: number | null = node.isTextblock ? nodePos + 1 + node.content.size : null
        if (insertPos === null) {
          node.descendants((child, offset) => {
            if (insertPos !== null) return false
            if (!child.isTextblock) return true
            insertPos = nodePos + 1 + offset + 1 + child.content.size
            return false
          })
        }
        if (insertPos !== null) {
          editor.view.dispatch(
            editor.state.tr.insertText(` ^${blockId}`, insertPos).setMeta("uiEvent", "input"),
          )
          anchor = `^${blockId}`
        }
      }
    }

    await navigator.clipboard.writeText(`[[${noteName}${anchor}]]`)
    onClose()
  }

  // The rows the arrow keys move over: every action button of the panel, in the order shown.
  const panelRows = () =>
    Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button.amby-block-row") ?? [])
  const submenuRows = () =>
    Array.from(
      turnIntoMenuRef.current?.querySelectorAll<HTMLButtonElement>("button.amby-block-row") ?? [],
    )

  // Shows the row the keyboard is on. Runs after every render: rows come and go as the
  // query changes, and the marking is only an attribute on them.
  React.useLayoutEffect(() => {
    const rows = panelRows()
    markActiveRow(rows, turnIntoOpen ? -1 : Math.min(active, rows.length - 1))
    markActiveRow(
      submenuRows(),
      turnIntoOpen ? Math.min(subActive, shownTurnIntoItems.length - 1) : -1,
    )
  })

  function closeTurnInto() {
    setTurnIntoOpen(false)
  }

  function onMenuKey(event: KeyboardEvent) {
    const key = event.key
    if (event.isComposing) return
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (turnIntoOpen) {
      const count = shownTurnIntoItems.length
      if (key === "ArrowDown" || key === "ArrowUp") {
        handled()
        const next = stepIndex(subActive, count, key === "ArrowDown" ? 1 : -1)
        setSubActive(next)
        revealRow(submenuRows()[next])
      } else if (key === "Enter") {
        handled()
        const item = shownTurnIntoItems[Math.min(subActive, count - 1)]
        if (item) chooseTurnInto(item)
      } else if (key === "ArrowLeft" || key === "Escape") {
        handled()
        closeTurnInto()
      }
      return
    }
    const rows = panelRows()
    if (key === "ArrowDown" || key === "ArrowUp") {
      handled()
      const next = stepIndex(active, rows.length, key === "ArrowDown" ? 1 : -1)
      setActive(next)
      revealRow(rows[next])
    } else if (key === "Home" || key === "End") {
      if (query) return
      handled()
      const next = key === "Home" ? 0 : rows.length - 1
      setActive(next)
      revealRow(rows[next])
    } else if (key === "Enter") {
      handled()
      rows[Math.min(active, rows.length - 1)]?.click()
      if (rows[Math.min(active, rows.length - 1)] === turnIntoBtnRef.current) setSubActive(0)
    } else if (key === "ArrowRight") {
      if (rows[Math.min(active, rows.length - 1)] === turnIntoBtnRef.current) {
        handled()
        if (!turnIntoOpen) turnIntoBtnRef.current?.click()
        setSubActive(0)
      }
    } else if (key === "Escape") {
      handled()
      onClose()
    }
  }

  // The keys belong to the menu while it is open, wherever the focus is (the search field,
  // or the note when the focus went back to it); another text field keeps its own keys.
  const onMenuKeyRef = React.useRef(onMenuKey)
  onMenuKeyRef.current = onMenuKey
  React.useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target
      const ours =
        target === searchRef.current ||
        target === document.body ||
        (target instanceof Node && editor.view.dom.contains(target))
      if (!ours || event.metaKey || event.ctrlKey || event.altKey) return
      onMenuKeyRef.current(event)
    }
    document.addEventListener("keydown", listener, true)
    return () => document.removeEventListener("keydown", listener, true)
  }, [editor])

  const isListItem = nodeType === "listItem" || nodeType === "taskItem"
  const pictureAt = pictureOfBlock(editor, nodePos)
  const hasContext =
    nodeType === "callout" ||
    nodeType === "heading" ||
    pictureAt !== null ||
    nodeType === "codeBlock" ||
    isListItem

  return (
    <motion.div
      ref={panelRef}
      className="amby-block-panel amby-block-panel--actions"
      initial={{ opacity: 0, scale: 0.97, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={motionTransitions.enter}
      style={placementStyle}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={(event) => {
        // The row under a pointer that really moved is the choice; one that arrived under
        // a resting pointer because the list scrolled is not.
        if (!pointerReallyMoved(pointerRef, event) || !(event.target instanceof Element)) return
        const row = event.target.closest("button.amby-block-row")
        const index = panelRows().findIndex((candidate) => candidate === row)
        if (index >= 0) setActive(index)
      }}
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
        {turnIntoVisible && (
          <MotionRowButton
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
                  // A zero-height side anchor aligns the submenu's first row
                  // with this row instead of opening underneath it.
                  bottom: rect.top - 4,
                  width: 0,
                  height: 0,
                })
              }
              setTurnIntoOpen((v) => !v)
            }}
          >
            <ChevronRight className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.turnInto")}</span>
            <span className="amby-block-row-hint">▸</span>
          </MotionRowButton>
        )}
        {(hasContext || splitVisible) && (
          <div className="amby-block-context-zone">
            {hasContext && (
              <>
                {isCallout && (
                  <CalloutContext editor={editor} nodePos={nodePos} matches={matches} />
                )}
                {nodeType === "heading" && (
                  <HeadingContext editor={editor} nodePos={nodePos} matches={matches} />
                )}
                {pictureAt !== null && (
                  <ImageContext
                    editor={editor}
                    pos={pictureAt}
                    matches={matches}
                    onClose={onClose}
                  />
                )}
                {nodeType === "codeBlock" && (
                  <CodeBlockContext editor={editor} nodePos={nodePos} matches={matches} />
                )}
                {isListItem && <ListContext editor={editor} nodePos={nodePos} matches={matches} />}
              </>
            )}
            {splitVisible && (
              <MotionRowButton
                type="button"
                className="amby-block-row"
                onClick={() => {
                  if (splitParagraphIntoBlocks(editor, nodePos)) onClose()
                }}
              >
                <Rows3 className="amby-block-row-icon" />
                <span className="amby-block-row-label">{t("blockPanel.splitBlocks")}</span>
              </MotionRowButton>
            )}
          </div>
        )}
        {!hasContext &&
          !splitVisible &&
          !turnIntoVisible &&
          matches(t("blockPanel.duplicate")) === false &&
          matches(t("blockPanel.delete")) === false && (
            <div className="amby-block-panel-empty">{t("blockPanel.noSettings")}</div>
          )}
      </div>

      <div className="amby-block-panel-footer">
        {matches(t("blockPanel.copyLink")) && (
          <MotionRowButton
            type="button"
            className="amby-block-row"
            onClick={() => void copyBlockLink()}
          >
            <LinkIcon className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.copyLink")}</span>
            <span className="amby-block-row-hint">⌘L</span>
          </MotionRowButton>
        )}
        {matches(t("blockPanel.duplicate")) && (
          <MotionRowButton type="button" className="amby-block-row" onClick={onDuplicate}>
            <Copy className="amby-block-row-icon" />
            <span className="amby-block-row-label">{t("blockPanel.duplicate")}</span>
            <span className="amby-block-row-hint">⌘D</span>
          </MotionRowButton>
        )}
        {insertVisible && (
          <>
            <MotionRowButton type="button" className="amby-block-row" onClick={onInsertAbove}>
              <ArrowUp className="amby-block-row-icon" />
              <span className="amby-block-row-label">{t("blockPanel.insertAbove")}</span>
            </MotionRowButton>
            <MotionRowButton type="button" className="amby-block-row" onClick={onInsertBelow}>
              <ArrowDown className="amby-block-row-icon" />
              <span className="amby-block-row-label">{t("blockPanel.insertBelow")}</span>
            </MotionRowButton>
          </>
        )}
        {matches(t("blockPanel.delete")) && (
          <div className="amby-block-panel-danger-zone">
            <MotionRowButton type="button" className="amby-block-row is-danger" onClick={onDelete}>
              <Trash2 className="amby-block-row-icon" />
              <span className="amby-block-row-label">{t("blockPanel.delete")}</span>
              <span className="amby-block-row-hint">⌫</span>
            </MotionRowButton>
          </div>
        )}
      </div>
      {turnIntoOpen && turnIntoAnchor && (
        <TurnIntoMenu
          anchorRect={turnIntoAnchor}
          items={shownTurnIntoItems}
          onChoose={chooseTurnInto}
          containerRef={turnIntoMenuRef}
          onPointerOver={setSubActive}
        />
      )}
    </motion.div>
  )
}

// ── Turn-into popover ────────────────────────────────────────────────────────

function TurnIntoMenu({
  anchorRect,
  items,
  onChoose,
  containerRef,
  onPointerOver,
}: {
  anchorRect: AnchorRect
  items: BlockInsertItem[]
  onChoose: (item: BlockInsertItem) => void
  /** Owned by the panel, which marks and scrolls the rows as the arrow keys move. */
  containerRef: React.RefObject<HTMLDivElement | null>
  onPointerOver: (index: number) => void
}) {
  const { t } = useTranslation()
  const style = useSmartPlacement(anchorRect, containerRef)
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null)
  return createPortal(
    <div
      ref={containerRef}
      className="amby-turn-into-menu"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={(event) => {
        if (!pointerReallyMoved(pointerRef, event) || !(event.target instanceof Element)) return
        const rows = Array.from(event.currentTarget.querySelectorAll("button.amby-block-row"))
        const index = rows.indexOf(event.target.closest("button.amby-block-row") as Element)
        if (index >= 0) onPointerOver(index)
      }}
    >
      {items.map((item) => (
        <MotionRowButton
          key={item.id}
          type="button"
          className="amby-block-row"
          onClick={() => onChoose(item)}
        >
          <item.icon className="amby-block-row-icon" />
          <span className="amby-block-row-label">{t(`blockItems.${item.id}.title`)}</span>
        </MotionRowButton>
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
  const [emojiOpen, setEmojiOpen] = React.useState(false)
  const [emojiAnchor, setEmojiAnchor] = React.useState<AnchorRect | null>(null)
  const emojiButtonRef = React.useRef<HTMLButtonElement>(null)
  const emojiPickerRef = React.useRef<HTMLDivElement>(null)
  const emojiPickerStyle = useSmartPlacement(emojiAnchor, emojiPickerRef, { gap: 6 })

  function setBg(id: string) {
    editor
      .chain()
      .focus()
      .updateAttributes("callout", { bgColor: id === "none" ? null : id })
      .run()
  }

  function setEmoji(nextEmoji: string) {
    if (!node) return
    const attrs: Record<string, unknown> = { emoji: nextEmoji }
    if (node.attrs.hasRawHeader) {
      const collapseMarker = /^[+-]/u.exec(String(node.attrs.headerPrefix ?? ""))?.[0] ?? ""
      attrs.headerPrefix = `${collapseMarker} ${nextEmoji}${node.attrs.headerContentInBody ? " " : ""}`
      attrs.headerSuffix = attrs.headerPrefix
    }
    editor.chain().focus().updateAttributes("callout", attrs).run()
    setEmojiOpen(false)
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

  function setFolding(mode: "none" | "expanded" | "collapsed") {
    if (!node) return
    const currentPrefix = String(node.attrs.headerPrefix ?? "")
    let nextPrefix: string
    let nextCollapsed: boolean | null
    if (mode === "none") {
      nextPrefix = currentPrefix.replace(/^[+-]/u, "").trimStart()
      if (!nextPrefix.startsWith(" ")) nextPrefix = " " + nextPrefix
      nextCollapsed = false
    } else if (mode === "expanded") {
      nextPrefix = currentPrefix.replace(/^[+-]?\s*/u, "+ ")
      nextCollapsed = false
    } else {
      nextPrefix = currentPrefix.replace(/^[+-]?\s*/u, "- ")
      nextCollapsed = true
    }
    const attrs: Record<string, unknown> = {
      headerPrefix: nextPrefix,
      headerSuffix: nextPrefix,
      hasRawHeader: true,
      isCollapsed: nextCollapsed,
    }
    editor.chain().focus().updateAttributes("callout", attrs).run()
  }

  const currentPrefix = String(node?.attrs.headerPrefix ?? "")
  const currentFoldMode: "none" | "expanded" | "collapsed" = currentPrefix.startsWith("-")
    ? "collapsed"
    : currentPrefix.startsWith("+")
      ? "expanded"
      : "none"

  const showBg = matches("background") || matches("фон") || matches("color")
  const showText = matches("text color") || matches("color") || matches("текст")
  const showEmoji = matches("emoji") || matches("эмодзи") || matches(t("callout.changeEmoji"))
  const showFolding =
    matches("fold") ||
    matches("collapse") ||
    matches("сворач") ||
    matches("раскрыт") ||
    matches(t("callout.foldable"))

  if (!showBg && !showText && !showEmoji && !showFolding) return null

  return (
    <>
      {showFolding && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.calloutFolding")}</div>
          <div className="flex items-center gap-1.5 mb-2">
            {[
              { id: "none" as const, label: t("callout.foldNone") },
              { id: "expanded" as const, label: t("callout.foldExpanded") },
              { id: "collapsed" as const, label: t("callout.foldCollapsed") },
            ].map((option) => (
              <button
                key={option.id}
                type="button"
                className={`amby-ctx-size-preset-btn ${currentFoldMode === option.id ? "is-active" : ""}`}
                onClick={() => setFolding(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
      {showBg && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.bgCallout")}</div>
          <div className="amby-ctx-swatches">
            {CALLOUT_SWATCHES.map((sw) => (
              <MotionSwatchButton
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
              </MotionSwatchButton>
            ))}
          </div>
        </>
      )}
      {showText && (
        <>
          <div className="amby-block-panel-section">{t("blockPanel.textColor")}</div>
          <div className="amby-ctx-swatches">
            {TEXT_COLORS.map((c) => (
              <MotionSwatchButton
                key={c.id}
                type="button"
                title={c.id}
                data-amby-color={c.color ? c.color.toLowerCase() : undefined}
                className={
                  c.color == null ? "amby-ctx-swatch amby-ctx-swatch--none" : "amby-ctx-swatch"
                }
                style={c.color ? { background: c.color } : undefined}
                onClick={() => setTextColor(c.color)}
              >
                {c.color == null && <Droplet className="size-3" />}
              </MotionSwatchButton>
            ))}
          </div>
        </>
      )}
      {showEmoji && (
        <MotionRowButton
          ref={emojiButtonRef}
          type="button"
          className="amby-block-row"
          onClick={() => {
            const rect = emojiButtonRef.current?.getBoundingClientRect()
            if (rect) setEmojiAnchor(rect)
            setEmojiOpen((open) => !open)
          }}
        >
          <span className="amby-block-row-icon amby-block-row-emoji" aria-hidden="true">
            {String(node?.attrs.emoji ?? "💡")}
          </span>
          <span className="amby-block-row-label">{t("callout.changeEmoji")}</span>
        </MotionRowButton>
      )}
      {emojiOpen &&
        emojiAnchor &&
        createPortal(
          <div
            ref={emojiPickerRef}
            className="amby-callout-context-emoji-picker"
            style={emojiPickerStyle}
          >
            <EmojiPickerPanel
              emojiOnly
              triggerRef={emojiButtonRef}
              onSelect={(emoji) => setEmoji(emoji.native)}
              onClose={() => setEmojiOpen(false)}
            />
          </div>,
          document.body,
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
    !matches("h5") &&
    !matches("h6")
  ) {
    return null
  }

  function setLevel(level: 1 | 2 | 3 | 4 | 5 | 6) {
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
        {([1, 2, 3, 4, 5, 6] as const).map((level) => (
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

/**
 * The position of the picture a block is about: the picture itself, or the only picture on a
 * line of its own. A player or a card drawn from an image node is not a picture.
 */
function pictureOfBlock(editor: Editor, nodePos: number): number | null {
  const node = editor.state.doc.nodeAt(nodePos)
  if (!node) return null
  const image =
    node.type.name === "image"
      ? { node, pos: nodePos }
      : node.type.name === "paragraph" &&
          node.childCount === 1 &&
          node.child(0).type.name === "image"
        ? { node: node.child(0), pos: nodePos + 1 }
        : null
  if (!image) return null
  const src = String(image.node.attrs.src ?? "")
  return attachmentKind(src) || localFileKind(src) ? null : image.pos
}

function ImageContext({
  editor,
  pos,
  matches,
  onClose,
}: {
  editor: Editor
  pos: number
  matches: (s: string) => boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const node = imageNodeAt(editor, pos)
  const src = String(node?.attrs.src ?? "")
  const align = (node?.attrs.align as string | null) ?? null
  const hasCustomSize = Boolean(node?.attrs.width || node?.attrs.height)
  const [caption, setCaption] = React.useState(String(node?.attrs.title ?? ""))
  const [alt, setAlt] = React.useState(String(node?.attrs.alt ?? ""))
  const [flyout, setFlyout] = React.useState<{
    kind: "align" | "details"
    anchor: AnchorRect
  } | null>(null)
  const flyoutRef = React.useRef<HTMLDivElement>(null)
  const flyoutStyle = useSmartPlacement(flyout?.anchor ?? null, flyoutRef)
  const canReplace = canEditImageFiles(editor)

  React.useEffect(() => {
    setCaption(String(node?.attrs.title ?? ""))
    setAlt(String(node?.attrs.alt ?? ""))
    setFlyout(null)
    // intentionally re-run when another picture is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos])

  // The menu changes the picture without selecting it: it stays open for the next change.
  const patch = (change: ImagePatch) => updateImageNode(editor, pos, src, change, false)

  /** Opens (or closes) a submenu to the right of the row that was pressed. */
  function toggleFlyout(kind: "align" | "details", row: HTMLElement) {
    const rect = row.getBoundingClientRect()
    setFlyout((current) =>
      current?.kind === kind
        ? null
        : {
            kind,
            anchor: {
              left: rect.right + 4,
              top: rect.top,
              right: rect.right + 4,
              bottom: rect.top - 4,
              width: 0,
              height: 0,
            },
          },
    )
  }

  const actions = [
    {
      id: "open",
      Icon: Maximize,
      label: t("editorToolbar.imageOpen"),
      run: () => requestImageViewer(editor, pos),
    },
    {
      id: "copy",
      Icon: Copy,
      label: t("editorToolbar.imageCopy"),
      run: () => copyImageAt(editor, pos),
    },
    {
      id: "save",
      Icon: Download,
      label: t("editorToolbar.imageSave"),
      run: () => saveImageAt(editor, pos, src),
    },
    ...(canReplace
      ? [
          {
            id: "replace",
            Icon: Replace,
            label: t("editorToolbar.imageReplace"),
            run: () => replaceImageAt(editor, pos, src),
          },
        ]
      : []),
    ...(canReplace && isVaultImage(src)
      ? [
          {
            id: "crop",
            Icon: Crop,
            label: t("editorToolbar.imageCrop"),
            run: () => requestImageCrop(editor, pos, src),
          },
        ]
      : []),
    ...(hasCustomSize
      ? [
          {
            id: "reset",
            Icon: RotateCcw,
            label: t("editorToolbar.imageResetSize"),
            run: () => patch({ width: null, height: null }),
          },
        ]
      : []),
  ].filter((action) => matches(action.label))

  const alignLabel = t("blockPanel.align")
  const detailsLabel = t("blockPanel.imageDetails")
  const showAlign = matches(alignLabel) || matches("align")
  const showDetails =
    matches(detailsLabel) ||
    matches("alt") ||
    matches("caption") ||
    matches(t("editorToolbar.imageCaption"))
  const alignments = [
    { id: "left", Icon: AlignLeft, label: t("editorToolbar.imageAlignLeft") },
    { id: "center", Icon: AlignCenter, label: t("editorToolbar.imageAlignCenter") },
    { id: "right", Icon: AlignRight, label: t("editorToolbar.imageAlignRight") },
  ] as const
  const currentAlign = align ?? "left"

  if (!node) return null

  return (
    <>
      {actions.map(({ id, Icon, label, run }) => (
        <MotionRowButton
          key={id}
          type="button"
          className="amby-block-row"
          onClick={() => {
            void run()
            onClose()
          }}
        >
          <Icon className="amby-block-row-icon" />
          <span className="amby-block-row-label">{label}</span>
        </MotionRowButton>
      ))}
      {showAlign && (
        <MotionRowButton
          type="button"
          className="amby-block-row"
          onClick={(event) => toggleFlyout("align", event.currentTarget)}
        >
          {currentAlign === "center" ? (
            <AlignCenter className="amby-block-row-icon" />
          ) : currentAlign === "right" ? (
            <AlignRight className="amby-block-row-icon" />
          ) : (
            <AlignLeft className="amby-block-row-icon" />
          )}
          <span className="amby-block-row-label">{alignLabel}</span>
          <span className="amby-block-row-hint">▸</span>
        </MotionRowButton>
      )}
      {showDetails && (
        <MotionRowButton
          type="button"
          className="amby-block-row"
          onClick={(event) => toggleFlyout("details", event.currentTarget)}
        >
          <Captions className="amby-block-row-icon" />
          <span className="amby-block-row-label">{detailsLabel}</span>
          <span className="amby-block-row-hint">▸</span>
        </MotionRowButton>
      )}
      {flyout &&
        createPortal(
          <div
            ref={flyoutRef}
            className="amby-turn-into-menu"
            style={flyout.kind === "details" ? { ...flyoutStyle, width: 260 } : flyoutStyle}
            onMouseDown={(event) => {
              // Rows keep the editor's focus. A field must take the focus itself: the press
              // would reach the menu (events pass through a portal to the tree above it),
              // which refuses the focus to everything.
              if (event.target instanceof HTMLInputElement) event.stopPropagation()
              else event.preventDefault()
            }}
          >
            {flyout.kind === "align" &&
              alignments.map(({ id, Icon, label }) => (
                <MotionRowButton
                  key={id}
                  type="button"
                  className="amby-block-row"
                  onClick={() => {
                    // Left is how a picture stands anyway: it is written as no alignment.
                    patch({ align: id === "left" ? null : id })
                    setFlyout(null)
                  }}
                >
                  <Icon className="amby-block-row-icon" />
                  <span className="amby-block-row-label">{label}</span>
                  {currentAlign === id && <Check className="amby-block-row-icon" />}
                </MotionRowButton>
              ))}
            {flyout.kind === "details" && (
              <div className="flex flex-col gap-1 p-1">
                <div className="amby-block-panel-section">{t("editorToolbar.imageCaption")}</div>
                <input
                  className="amby-ctx-text-input"
                  autoFocus
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  onBlur={() => patch({ title: caption.trim() || null })}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === "Enter") {
                      e.preventDefault()
                      patch({ title: caption.trim() || null })
                    }
                    if (e.key === "Escape") setFlyout(null)
                  }}
                  placeholder={t("editorToolbar.imageCaptionPlaceholder")}
                />
                <div className="amby-block-panel-section">{t("blockPanel.altText")}</div>
                <input
                  className="amby-ctx-text-input"
                  value={alt}
                  onChange={(e) => setAlt(e.target.value)}
                  onBlur={() => patch({ alt: alt || null })}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === "Enter") {
                      e.preventDefault()
                      patch({ alt: alt || null })
                    }
                    if (e.key === "Escape") setFlyout(null)
                  }}
                  placeholder={t("blockPanel.imagePlaceholder")}
                />
              </div>
            )}
          </div>,
          document.body,
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
