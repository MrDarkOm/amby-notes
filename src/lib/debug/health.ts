import type { DebugBackendStatus } from "./types"
import { getDebugStatus, isTauri } from "@/lib/storage"
import { inspectRecoveryQueue } from "@/lib/recovery-drafts"
import { inspectAutosaveGeneration } from "@/components/workspace/autosave/autosave-lifecycle"
import { useDocStore, type Document } from "@/components/workspace/use-doc-store"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import { useViewStateStore, getLayerViewMode } from "@/components/workspace/use-view-state-store"
import { useSettingsStore } from "@/components/workspace/use-settings-store"
import { moduleHost } from "@/lib/modules/host/module-host"
import { safeModeState } from "@/lib/modules/host/safe-mode"
import type { DocumentViewMode } from "@/components/workspace/editor/use-document-view-mode"
import { installDebugHealthBridge, requestWorkspaceDebugHealth } from "./health-bridge"

export interface DebugHealthSnapshot {
  runtime: "desktop" | "browser"
  generatedAt: string
  documents: {
    open: number
    dirty: number
    conflicts: number
    source: number
    livePreview: number
  }
  autosave: ReturnType<typeof inspectAutosaveGeneration>
  recovery: ReturnType<typeof inspectRecoveryQueue>
  modules: { enabled: number; safeMode: boolean }
  backend: DebugBackendStatus | null
  editorReasons: Record<string, number>
}

// Diagnostic refresh is opt-in, and must not parse an unbounded open workspace.
const MAX_INSPECTED_DOCUMENTS = 50
const MAX_DOCUMENT_CHARS = 200_000
const MAX_TOTAL_CHARS = 1_000_000

export function projectDebugDocuments(
  documents: Record<string, Pick<Document, "content" | "noteProperties">>,
  dirty: ReadonlySet<string>,
  conflicts: Record<string, unknown>,
  viewModes: Record<string, DocumentViewMode>,
  defaultMode: DocumentViewMode,
  roundTrip: (content: string) => { ok: boolean },
): Pick<DebugHealthSnapshot, "documents" | "editorReasons"> {
  const entries = Object.entries(documents)
  const reasons: Record<string, number> = {}
  let source = 0
  let livePreview = 0
  let inspectedChars = 0
  const addReason = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  entries.forEach(([id, document], index) => {
    const forcedSource = document.noteProperties?.frontmatterStatus === "unterminated"
    const mode = forcedSource ? "source" : getLayerViewMode(viewModes, id, "editor", defaultMode)
    if (mode === "source") source += 1
    if (mode === "live") livePreview += 1
    if (forcedSource) {
      addReason("unterminated_frontmatter")
      return
    }
    if (document.noteProperties?.bodyReadOnly) addReason("identity_read_only")
    if (
      index >= MAX_INSPECTED_DOCUMENTS ||
      document.content.length > MAX_DOCUMENT_CHARS ||
      inspectedChars + document.content.length > MAX_TOTAL_CHARS
    ) {
      addReason("inspection_limit")
      return
    }
    inspectedChars += document.content.length
    try {
      if (!roundTrip(document.content).ok) {
        // Footnotes are part of Live Preview now; `[^label]: text` is not a link definition.
        if (/^ {0,3}\[(?!\^)[^\]\r\n]+\]:\s*\S/mu.test(document.content))
          addReason("reference_links")
        else if (
          /\r(?!\n)/u.test(document.content) ||
          (document.content.includes("\r\n") && /(^|[^\r])\n/u.test(document.content))
        )
          addReason("mixed_line_endings")
        else addReason("round_trip_mismatch")
      } else if (mode === "source") addReason("source_selected")
    } catch {
      addReason("inspection_failed")
    }
  })
  return {
    documents: {
      open: entries.length,
      dirty: entries.filter(([id]) => dirty.has(id)).length,
      conflicts: Object.keys(conflicts).filter((id) => id in documents).length,
      source,
      livePreview,
    },
    editorReasons: reasons,
  }
}

/** Reads existing owners only. Does not save, flush, repair, or read note files. */
async function collectLocalDebugHealth(): Promise<DebugHealthSnapshot> {
  const vault = useVaultStore.getState()
  const documents = useDocStore.getState()
  const settings = useSettingsStore.getState()
  const views = useViewStateStore.getState()
  const { roundTripCheck } = await import("@/components/workspace/tiptap/markdown")
  const projection = projectDebugDocuments(
    documents.openDocs,
    documents.unsavedFileIds,
    documents.externalConflicts,
    views.viewModes,
    settings.prefs.editor.defaultViewMode,
    roundTripCheck,
  )
  return {
    runtime: isTauri() ? "desktop" : "browser",
    generatedAt: new Date().toISOString(),
    ...projection,
    autosave: inspectAutosaveGeneration(vault.generation),
    recovery: inspectRecoveryQueue({ vault: vault.vault, generation: vault.backendGeneration }),
    modules: {
      enabled: moduleHost.getActiveModuleIds().length,
      safeMode: safeModeState.isEnabled(),
    },
    backend: isTauri() ? await getDebugStatus().catch(() => null) : null,
  }
}

export async function collectDebugHealth(): Promise<DebugHealthSnapshot> {
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    if (getCurrentWindow().label === "settings") {
      const projection = await requestWorkspaceDebugHealth()
      return { ...projection, backend: await getDebugStatus().catch(() => null) }
    }
  }
  return collectLocalDebugHealth()
}

export async function initDebugHealthBridge(): Promise<void> {
  if (isTauri()) await installDebugHealthBridge(collectLocalDebugHealth)
}
