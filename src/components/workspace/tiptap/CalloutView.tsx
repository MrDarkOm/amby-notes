"use client"

import * as React from "react"
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react"
import type { NodeViewProps } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { ChevronDown } from "lucide-react"

import { motionTransitions } from "@/lib/motion-config"
import { EmojiPickerPanel } from "./EmojiPickerPanel"
import { CLOSE_BLOCK_MENUS_EVENT, CLOSE_EDITOR_MENUS_EVENT } from "./floating-menu-events"

/**
 * React NodeView for the `callout` node.
 *
 * Visual: Notion-style rounded container with a left color accent, a centered
 * emoji slot, and an editable content area. Clicking the emoji opens the
 * emoji picker (only in editable mode). Foldable callouts display a toggle
 * chevron to collapse and expand the body content.
 *
 * The border / background color is determined by data-callout-type and CSS.
 */
export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const emojiSlotRef = React.useRef<HTMLDivElement>(null)
  const { calloutType, emoji, bgColor, hasRawHeader, headerPrefix, headerContentInBody } =
    node.attrs as {
      calloutType: string
      emoji: string
      bgColor: string | null
      hasRawHeader: boolean
      headerPrefix: string
      headerContentInBody: boolean
    }

  const isFoldable = /^[+-]/u.test(headerPrefix)
  const isCollapsed =
    typeof node.attrs.isCollapsed === "boolean"
      ? node.attrs.isCollapsed
      : headerPrefix.startsWith("-")

  const animRef = React.useRef<HTMLDivElement>(null)
  const [collapsedHeight, setCollapsedHeight] = React.useState<number>(27)

  React.useLayoutEffect(() => {
    if (!animRef.current) return
    const firstBlock = animRef.current.querySelector<HTMLElement>(".amby-callout-content > *")
    if (firstBlock) {
      const computedLh = parseFloat(window.getComputedStyle(firstBlock).lineHeight)
      if (computedLh > 0) {
        setCollapsedHeight(Math.round(computedLh))
      } else if (firstBlock.offsetHeight > 0) {
        setCollapsedHeight(firstBlock.offsetHeight)
      }
    }
  }, [node])

  function toggleFold(e?: React.MouseEvent) {
    e?.stopPropagation()
    e?.preventDefault()
    const nextCollapsed = !isCollapsed
    let nextPrefix: string
    if (isFoldable) {
      nextPrefix = nextCollapsed
        ? headerPrefix.replace(/^\+/u, "-")
        : headerPrefix.replace(/^-/u, "+")
    } else {
      nextPrefix = headerPrefix ? headerPrefix.replace(/^[+-]?\s*/u, "- ") : "- "
    }
    updateAttributes({
      isCollapsed: nextCollapsed,
      headerPrefix: nextPrefix,
      headerSuffix: nextPrefix,
      hasRawHeader: true,
    })
  }

  function handleEmojiSelect(emojiData: { native: string }) {
    const attrs: Record<string, unknown> = { emoji: emojiData.native }
    if (hasRawHeader) {
      const collapseMarker = /^[+-]/u.exec(headerPrefix)?.[0] ?? ""
      attrs.headerPrefix = `${collapseMarker} ${emojiData.native}${headerContentInBody ? " " : ""}`
      attrs.headerSuffix = attrs.headerPrefix
    }
    updateAttributes(attrs)
    setPickerOpen(false)
  }

  const defaultTitle = calloutType.charAt(0).toUpperCase() + calloutType.slice(1).toLowerCase()
  const hasContent = node.textContent.trim().length > 0 || headerContentInBody

  return (
    <NodeViewWrapper
      data-callout-type={calloutType}
      data-bg={bgColor ?? undefined}
      data-foldable={isFoldable ? "true" : undefined}
      data-collapsed={isCollapsed ? "true" : undefined}
      className={`amby-callout-node${isCollapsed ? " is-collapsed" : ""}`}
    >
      <div
        className="amby-callout-inner"
        onClick={isCollapsed ? toggleFold : undefined}
        style={{ cursor: isCollapsed ? "pointer" : undefined }}
      >
        {/* ── Emoji slot ─────────────────────────────────────────────── */}
        <div ref={emojiSlotRef} className="amby-callout-emoji-slot" contentEditable={false}>
          <motion.button
            type="button"
            className="amby-callout-emoji-btn"
            whileHover={editor.isEditable ? { scale: 1.15 } : undefined}
            whileTap={editor.isEditable ? { scale: 0.96 } : undefined}
            transition={motionTransitions.default}
            onClick={(e) => {
              if (!editor.isEditable) return
              e.stopPropagation()
              if (pickerOpen) {
                setPickerOpen(false)
              } else {
                window.dispatchEvent(new Event(CLOSE_BLOCK_MENUS_EVENT))
                window.dispatchEvent(new Event(CLOSE_EDITOR_MENUS_EVENT))
                setPickerOpen(true)
              }
            }}
            title={editor.isEditable ? t("callout.changeEmoji") : undefined}
            aria-label={t("callout.emoji")}
          >
            {emoji}
          </motion.button>

          {pickerOpen && (
            <div className="amby-callout-picker-anchor" contentEditable={false}>
              <EmojiPickerPanel
                emojiOnly
                triggerRef={emojiSlotRef}
                onSelect={handleEmojiSelect}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          )}
        </div>

        {/* ── Editable content ────────────────────────────────────────── */}
        <div className="amby-callout-content-wrap">
          {!hasContent && isCollapsed ? (
            <div
              className="amby-callout-title select-none cursor-pointer truncate"
              onClick={toggleFold}
              title={defaultTitle}
            >
              {defaultTitle}
            </div>
          ) : (
            <motion.div
              ref={animRef}
              initial={false}
              animate={{
                height: isCollapsed ? collapsedHeight : "auto",
              }}
              transition={motionTransitions.panel}
              style={{ overflow: "hidden" }}
              className={`amby-callout-anim${isCollapsed ? " is-collapsed select-none" : ""}`}
            >
              <NodeViewContent className="amby-callout-content" />
            </motion.div>
          )}
        </div>

        {/* ── Fold toggle button ─────────────────────────────────────── */}
        <div
          className={`amby-callout-fold-slot${isFoldable ? "" : " is-optional"}`}
          contentEditable={false}
        >
          <button
            type="button"
            className={`amby-callout-fold-btn${isFoldable ? " is-foldable" : ""}`}
            onClick={toggleFold}
            title={isCollapsed ? t("callout.expand") : t("callout.collapse")}
            aria-label={isCollapsed ? t("callout.expand") : t("callout.collapse")}
          >
            <motion.span
              animate={{ rotate: isCollapsed ? -90 : 0 }}
              transition={motionTransitions.panel}
              className="inline-flex items-center justify-center"
            >
              <ChevronDown className="size-4" />
            </motion.span>
          </button>
        </div>
      </div>
    </NodeViewWrapper>
  )
}
