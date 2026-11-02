import * as React from "react"
import { useDocStore } from "../use-doc-store"
import type { DocumentEditorProps } from "../document-editor"
import type { HeaderTab } from "../header-tabs"

// Keep those libraries out of the startup path until a document is rendered.
export const DocumentEditor = React.lazy(() =>
  import("../document-editor").then((m) => ({ default: m.DocumentEditor })),
)
const MemoizedDocumentEditor = React.memo(DocumentEditor)

interface CachedDocumentEditorProps {
  editorProps: DocumentEditorProps
  visible: boolean
  isFocusMode: boolean
  hideNavigation: boolean
  focusTabs: HeaderTab[]
  activeTabKey?: string
  onFocusTabChange?: (key: string) => void
  focusFavorites?: Set<string>
  onFocusToggleFavorite?: (id: string) => void
  onFocusCloseAllTabs?: () => void
  onToggleFocusMode: () => void
}

/**
 * Hidden tabs keep their editor state, but should not rerender when unrelated
 * workspace state changes. They receive fresh props as soon as they become
 * visible again.
 */
const CachedDocumentEditor = React.memo(
  function CachedDocumentEditor({
    editorProps,
    visible,
    isFocusMode,
    hideNavigation,
    focusTabs,
    activeTabKey,
    onFocusTabChange,
    focusFavorites,
    onFocusToggleFavorite,
    onFocusCloseAllTabs,
    onToggleFocusMode,
  }: CachedDocumentEditorProps) {
    const editorRootRef = React.useRef<HTMLDivElement>(null)
    const controlsRef = React.useRef({
      isFocusMode,
      hideNavigation,
      focusTabs,
      activeTabKey,
      onFocusTabChange,
      focusFavorites,
      onFocusToggleFavorite,
      onFocusCloseAllTabs,
      onToggleFocusMode,
    })
    // A pane that is being hidden keeps the last visible editor controls. The
    // wrapper still updates its visibility and scroll restoration, while the
    // expensive editor subtree can bail out through React.memo.
    if (visible) {
      controlsRef.current = {
        isFocusMode,
        hideNavigation,
        focusTabs,
        activeTabKey,
        onFocusTabChange,
        focusFavorites,
        onFocusToggleFavorite,
        onFocusCloseAllTabs,
        onToggleFocusMode,
      }
    }
    const controls = controlsRef.current

    // A hidden pane stays mounted and keeps its own scroll offset, so the saved position is
    // applied only the first time a document is shown here. Re-applying it on every return to
    // the tab used a position captured when the pane was created and jumped back to the top.
    const restoredKeyRef = React.useRef<string | undefined>(undefined)
    React.useLayoutEffect(() => {
      if (!visible) return
      const key = editorProps.scrollPositionKey ?? ""
      if (restoredKeyRef.current === key) return
      restoredKeyRef.current = key
      const top = Math.max(0, editorProps.scrollPosition ?? 0)
      const restore = () => {
        const element = editorRootRef.current?.querySelector<HTMLElement>(".amby-editor-scroll")
        if (element) element.scrollTop = top
      }
      restore()
      const frame = requestAnimationFrame(restore)
      return () => cancelAnimationFrame(frame)
    }, [editorProps.scrollPosition, editorProps.scrollPositionKey, visible])

    return (
      <div ref={editorRootRef} className="flex min-h-0 min-w-0 flex-1">
        <MemoizedDocumentEditor
          key={editorProps.document?.id ?? "none"}
          {...editorProps}
          isFocusMode={controls.isFocusMode}
          isLocked={editorProps.isLocked}
          hideNavigation={controls.hideNavigation}
          focusTabs={controls.focusTabs}
          activeTabKey={controls.activeTabKey}
          onFocusTabChange={controls.onFocusTabChange}
          focusFavorites={controls.focusFavorites}
          onFocusToggleFavorite={controls.onFocusToggleFavorite}
          onFocusCloseAllTabs={controls.onFocusCloseAllTabs}
          onToggleFocusMode={controls.onToggleFocusMode}
        />
      </div>
    )
  },
  (previous, next) => {
    if (!next.visible) return true
    if (!previous.visible) return false
    return (
      previous.editorProps === next.editorProps &&
      previous.isFocusMode === next.isFocusMode &&
      previous.hideNavigation === next.hideNavigation &&
      previous.focusTabs === next.focusTabs &&
      previous.activeTabKey === next.activeTabKey &&
      previous.focusFavorites === next.focusFavorites &&
      previous.onFocusTabChange === next.onFocusTabChange &&
      previous.onFocusToggleFavorite === next.onFocusToggleFavorite &&
      previous.onFocusCloseAllTabs === next.onFocusCloseAllTabs &&
      previous.onToggleFocusMode === next.onToggleFocusMode
    )
  },
)

export const ConnectedCachedDocumentEditor = React.memo(function ConnectedCachedDocumentEditor({
  editorProps,
  ...props
}: CachedDocumentEditorProps) {
  const documentId = editorProps.document?.id ?? null
  const document = useDocStore((state) =>
    documentId ? (state.openDocs[documentId] ?? null) : null,
  )
  const connectedProps = React.useMemo(
    () => ({ ...editorProps, document: document ?? editorProps.document }),
    [document, editorProps],
  )
  return <CachedDocumentEditor editorProps={connectedProps} {...props} />
})
