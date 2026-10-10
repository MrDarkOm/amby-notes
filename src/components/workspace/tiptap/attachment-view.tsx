import * as React from "react"
import type { Editor } from "@tiptap/core"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { File as FileIcon, FileMusic, FileText, FileVideo } from "lucide-react"
import { useTranslation } from "react-i18next"

import { isRemoteAddress, type CardKind } from "./attachment-kind"
import { isTauri } from "@/lib/storage"
import { openAttachmentWithSystem } from "./external-open"
import {
  getAssetContext,
  getAssetResolverRevision,
  primeAssetConverter,
  resolveAssetSrcCandidates,
  resolveEmbeddedFileCandidates,
  subscribeAssetResolver,
} from "./asset-resolver"

const ICONS = { audio: FileMusic, video: FileVideo, pdf: FileText, file: FileIcon } as const

// WebKit draws the first frame of a video as its poster only when asked to start there.
const FIRST_FRAME = "#t=0.001"

// The element that holds the node view of an image is draggable. A press and a move on a
// player's controls (the scrubber, the volume) therefore start a drag of the whole node, and
// that drag takes the mouse: the scrubber stays glued to it until a click elsewhere. The
// controls keep their presses to themselves, so the only sign is the drag itself: a drag
// whose source holds a player is cancelled before the editor sees it.
const PLAYER_SELECTOR = '[data-attachment="audio"], [data-attachment="video"]'
let dragGuardInstalled = false

function installDragGuard() {
  if (dragGuardInstalled || typeof document === "undefined") return
  dragGuardInstalled = true
  document.addEventListener(
    "dragstart",
    (event) => {
      const source = event.target
      if (!(source instanceof Element) || !source.querySelector(PLAYER_SELECTOR)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true,
  )
}

function keepDragsOffPlayer(element: HTMLElement | null) {
  if (element) installDragGuard()
}

interface AttachmentPlayerProps {
  kind: CardKind
  /** Addresses to try in turn; the first one the webview can load is used. */
  candidates: string[]
  /** The file name shown on the card and used to label the player. */
  name: string
  /** The address points outside the vault: nothing is loaded for it. */
  remote?: boolean
  /** What the "Open" button of a card hands to the system: the note and the file as written. */
  open?: { notePath: string; address: string } | null
}

/**
 * An audio or video file played in place, or a card for anything else (a PDF, a file
 * the webview cannot play, a file that is missing, an address outside the vault). The
 * note's text is not touched: this only decides how the address is shown.
 */
export function AttachmentPlayer({ kind, candidates, name, remote, open }: AttachmentPlayerProps) {
  const { t } = useTranslation()
  const [index, setIndex] = React.useState(0)
  const key = candidates.join("\n")
  React.useEffect(() => {
    setIndex(0)
  }, [key])

  const playable = (kind === "audio" || kind === "video") && !remote
  const source = candidates[index]
  const failed = !source || index >= candidates.length
  const onError = () => setIndex((current) => current + 1)

  if (playable && !failed) {
    const common = {
      src: source,
      controls: true,
      preload: "metadata" as const,
      "aria-label": name,
      onError,
    }
    return (
      <span
        ref={keepDragsOffPlayer}
        className={`amby-attachment amby-attachment--${kind}`}
        data-attachment={kind}
      >
        {/* A new address is a new player: the element is rebuilt, not reused. */}
        {kind === "audio" ? (
          <audio key={source} {...common} />
        ) : (
          <video key={source} {...common} src={`${source}${FIRST_FRAME}`} playsInline />
        )}
      </span>
    )
  }

  const Icon = ICONS[kind]
  const note = remote
    ? t("attachment.remote")
    : kind === "pdf"
      ? t("attachment.pdf")
      : kind === "file"
        ? t("attachment.file")
        : playable
          ? t("attachment.unplayable")
          : null
  return (
    <span
      className="amby-attachment amby-attachment--card"
      data-attachment={kind}
      onClick={(event) => {
        // Cmd or Ctrl and a click anywhere on the card opens the file, as the button does.
        if (!(event.metaKey || event.ctrlKey) || !open || remote) return
        event.preventDefault()
        event.stopPropagation()
        void openAttachmentWithSystem(open.notePath, open.address)
      }}
    >
      <Icon className="amby-attachment-icon" aria-hidden />
      <span className="amby-attachment-text">
        <span className="amby-attachment-name">{name}</span>
        {note && <span className="amby-attachment-note">{note}</span>}
      </span>
      {open && !remote && (
        <button
          type="button"
          className="amby-attachment-open"
          // The editor must neither move its cursor nor start a drag from the button.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void openAttachmentWithSystem(open.notePath, open.address)
          }}
        >
          {t("externalOpen.open")}
        </button>
      )}
    </span>
  )
}

/** Re-renders when the editor learns where the note lives, so a relative path can be resolved. */
function useAssetResolverRevision(editor: Editor | null) {
  const subscribe = React.useCallback(
    (listener: () => void) => subscribeAssetResolver(editor, listener),
    [editor],
  )
  const getSnapshot = React.useCallback(() => getAssetResolverRevision(editor), [editor])
  React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  React.useEffect(() => {
    void primeAssetConverter()
  }, [])
}

/** The Open button exists where the system can open files: the desktop app, in a saved note. */
function openRequest(editor: Editor | null, address: string) {
  const notePath = editor ? getAssetContext(editor)?.notePath : undefined
  return isTauri() && notePath ? { notePath, address } : null
}

function fileName(address: string): string {
  const path = address.split(/[?#]/u, 1)[0] ?? address
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
  try {
    return decodeURIComponent(name) || address
  } catch {
    return name || address
  }
}

/** `![name](assets/file.mp3)`: an image node whose address is an audio, video or PDF file. */
export function AttachmentImageView({
  kind,
  node,
  editor,
  selected,
}: NodeViewProps & { kind: CardKind }) {
  useAssetResolverRevision(editor ?? null)
  const src = node.attrs.src as string
  const remote = isRemoteAddress(src)
  const alt = (node.attrs.alt as string | null) || fileName(src)
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className={`amby-image-wrap amby-attachment-wrap${selected ? " is-selected" : ""}`}
      data-asset-src={src}
    >
      <AttachmentPlayer
        kind={kind}
        candidates={remote ? [] : resolveAssetSrcCandidates(editor ?? null, src)}
        name={alt}
        remote={remote}
        open={openRequest(editor ?? null, src)}
      />
    </NodeViewWrapper>
  )
}

/** `![[file.mp3]]`: an Obsidian embed of a file, which the editor otherwise reads as a note. */
export function EmbeddedAttachment({
  kind,
  editor,
  target,
}: {
  kind: CardKind
  editor: Editor | null
  target: string
}) {
  useAssetResolverRevision(editor)
  return (
    <AttachmentPlayer
      kind={kind}
      candidates={resolveEmbeddedFileCandidates(editor, target)}
      name={fileName(target)}
      open={openRequest(editor, target)}
    />
  )
}
