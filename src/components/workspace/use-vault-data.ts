import * as React from "react"
import { useTranslation } from "react-i18next"
import { useVaultStore } from "./use-vault-store"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useViewStateStore } from "./use-view-state-store"
import { useSettingsStore } from "./use-settings-store"
import {
  loadSession,
  loadWorkspaces,
  saveSession,
  saveWorkspaces,
  SESSION_SCHEMA_VERSION,
  WORKSPACES_SCHEMA_VERSION,
} from "./app-config"
import { remapRecoveryDraft } from "@/lib/recovery-drafts"
import { applySessionRemap, reconcileTreeBackedTabTitles } from "./workspace-mutations"
import {
  flattenFileItems,
  flattenTree,
  findTreeItem,
  applyIconOverrides,
  newTabKey,
} from "./workspace-tree-utils"
import { buildLinkGraph } from "./wiki-links"
import type { TreeItem } from "./sidebar-tree"
import {
  isTauri,
  readFile,
  readNote,
  loadVaultData,
  loadActiveVaultData,
  preflightVault,
  applyIdMigration,
  recoverIdMigration,
  getLinkGraph,
  startVaultWatcher,
  stopVaultWatcher,
  confirmAction,
  showErrorMessage,
  type LinkGraph,
} from "@/lib/storage"
import { emit, listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { errorType, logger } from "@/lib/logger"
import { cancelAutosaveGeneration, flushAutosaveGeneration } from "./autosave/autosave-lifecycle"
import {
  activationMatchesCurrentVault,
  MAIN_WINDOW_LABEL,
  ownsWorkspacePersistence,
  ownsVaultWatcher,
  planVaultStartup,
  type VaultActivatedPayload,
} from "./windows/vault-window-lifecycle"
import { planOpenDocumentTreeChanges } from "./watcher-tree-reconciliation"

const VAULT_ACTIVATED_EVENT = "amby:vault-activated"

/**
 * Owns the vault tree, link graph, session persistence, and the Rust-side
 * file watcher. Returns the handful of values that the Workspace orchestrator
 * and downstream handlers need to read.
 *
 * Collaborates with useVaultStore, useDocStore, useTabsStore,
 * useViewStateStore, and useSettingsStore but does not own them.
 */
export function useVaultData() {
  const { t } = useTranslation()
  const desktop = isTauri()
  const windowLabel = desktop ? getCurrentWindow().label : MAIN_WINDOW_LABEL
  const ownsWatcher = ownsVaultWatcher(desktop, windowLabel)
  const ownsPersistence = ownsWorkspacePersistence(desktop, windowLabel)
  const vault = useVaultStore((s) => s.vault)
  const vaults = useVaultStore((s) => s.vaults)
  const { setVault, setVaults, setBackendGeneration } = useVaultStore.getState()

  const { patchDoc, markSaved, setExternalConflict, clearExternalConflict, clearDocs } =
    useDocStore.getState()
  const { setTabs, setActiveTabKey } = useTabsStore.getState()

  // For the session persist effect we need reactive reads.
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const favorites = useViewStateStore((s) => s.favorites)
  const viewModes = useViewStateStore((s) => s.viewModes)
  const nestedNotesPlacements = useViewStateStore((s) => s.nestedNotesPlacements)
  const lockedFileIds = useViewStateStore((s) => s.lockedFileIds)
  const iconOverrides = useViewStateStore((s) => s.iconOverrides)
  const { hydrateFromSession } = useViewStateStore.getState()

  const [treeItems, setTreeItems] = React.useState<TreeItem[]>([])
  const [linkGraph, setLinkGraph] = React.useState<LinkGraph>({ nodes: [], edges: [] })

  // sessionHydratedRef: false while loadVault is applying a restored session so
  // the persist effect doesn't immediately echo the just-restored state back.
  const sessionHydratedRef = React.useRef(false)
  const workspacesHydrated = React.useRef(false)
  const switchRef = React.useRef({ inFlight: false, requestId: 0 })
  const loadVaultRef = React.useRef<
    (path: string | null, activateBackend?: boolean) => Promise<void>
  >(async () => {})

  // ── Tree helpers ────────────────────────────────────────────────────────────

  function addVaultToList(path: string) {
    setVaults((prev) => {
      if (prev.find((v) => v.path === path)) return prev
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path
      return [...prev, { id: crypto.randomUUID(), name, path }]
    })
  }

  async function refreshTree(path: string | null = vault): Promise<TreeItem[]> {
    if (!path) return []
    const requestId = switchRef.current.requestId
    const loaded = await loadActiveVaultData()
    if (
      requestId !== switchRef.current.requestId ||
      useVaultStore.getState().vault !== path ||
      loaded.vaultPath !== path
    ) {
      return []
    }
    setBackendGeneration(loaded.generation)
    setTreeItems(loaded.tree)
    setTabs((previous) => reconcileTreeBackedTabTitles(previous, loaded.tree))
    return loaded.tree
  }

  /** Re-scan the vault and clear the rendered link graph while its index rebuilds. */
  async function reloadVaultData(): Promise<void> {
    if (!vault) return
    setLinkGraph({ nodes: [], edges: [] })
    await refreshTree(vault)
  }

  // ── loadVault ───────────────────────────────────────────────────────────────

  async function loadVault(path: string | null, activateBackend = true) {
    const currentVault = useVaultStore.getState().vault
    if (switchRef.current.inFlight) return
    if (activateBackend && (!path || path === currentVault)) return
    const requestId = switchRef.current.requestId + 1
    switchRef.current = { inFlight: true, requestId }
    const oldGeneration = useVaultStore.getState().generation
    try {
      if (currentVault) {
        let flush = { flushed: false, participants: 0 }
        try {
          flush = await flushAutosaveGeneration(oldGeneration)
        } catch (error) {
          logger.warn("vault_switch.autosave_flush_failed", { errorType: errorType(error) })
        }
        if (!flush.flushed && !(await confirmAction(t("recovery.switchAfterSaveFailure")))) return
      }
      if (desktop && activateBackend && path) {
        let preflight = await preflightVault(path)
        let unfinished = preflight.unfinishedMigrations[0]
        while (unfinished) {
          const resume = await confirmAction(
            t("workspace.migrationResumeConfirm", { files: unfinished.files.length }),
          )
          if (resume) {
            await recoverIdMigration(path, unfinished.journalPath, "resume")
            preflight = await preflightVault(path)
            unfinished = preflight.unfinishedMigrations[0]
          } else {
            const rollback = await confirmAction(t("workspace.migrationRollbackConfirm"))
            if (rollback) {
              await recoverIdMigration(path, unfinished.journalPath, "rollback")
            }
            // Canceling both dialogs is inspect-only: do not load the vault,
            // because indexing could otherwise change the partial migration.
            return
          }
        }
        if (preflight.plannedIdWrites.length > 0) {
          const preview = preflight.plannedIdWrites.slice(0, 8).join("\n")
          const remaining = preflight.plannedIdWrites.length - 8
          const conflicts = [
            preflight.malformedFrontmatter.length > 0 &&
              `${preflight.malformedFrontmatter.length} malformed frontmatter file(s)`,
            preflight.userManagedIds.length > 0 &&
              `${preflight.userManagedIds.length} user-managed id(s)`,
            preflight.duplicateIds.length > 0 &&
              `${preflight.duplicateIds.length} duplicate Amby id(s)`,
          ].filter(Boolean)
          const accepted = await confirmAction(
            `Amby found ${preflight.notes} note(s) and will add IDs to ${preflight.plannedIdWrites.length} file(s).\n\n${preview}${remaining > 0 ? `\n… and ${remaining} more` : ""}\n\nA backup and migration journal will be created first.${conflicts.length ? `\n\nReported without changes: ${conflicts.join(", ")}` : ""}\n\nContinue?`,
          )
          if (!accepted) return
          await applyIdMigration(path)
        }
      }
      const loaded = activateBackend ? await loadVaultData(path!) : await loadActiveVaultData()
      if (switchRef.current.requestId !== requestId) return
      const activePath = loaded.vaultPath
      const tree = loaded.tree
      const pathToId = loaded.sync.pathToId ?? {}
      const allIds = flattenTree(tree)

      // Activation succeeded. Only now detach the old generation and clear
      // process-local data that must never cross vault boundaries.
      if (currentVault) cancelAutosaveGeneration(oldGeneration)
      clearDocs()
      setTabs([])
      setActiveTabKey("")
      setVault(activePath)
      setBackendGeneration(loaded.generation)
      setTreeItems(tree)
      setLinkGraph({ nodes: [], edges: [] })
      addVaultToList(activePath)

      // Suppress session persistence while restoring state so we don't
      // immediately clobber the just-read session.json with empty state.
      sessionHydratedRef.current = false
      const session = await loadSession(activePath)
      if (switchRef.current.requestId !== requestId) return

      const restoreSession = useSettingsStore.getState().prefs.startup.restoreSession
      const remapped = applySessionRemap(session, pathToId, allIds, restoreSession)

      hydrateFromSession({
        icons: remapped.icons,
        favorites: remapped.favorites,
        viewModes: remapped.viewModes,
        nestedNotesPlacements: remapped.nestedNotesPlacements,
        lockedFileIds: remapped.lockedFileIds,
      })

      const valid = remapped.tabs
      const mappedActiveFileId = remapped.activeFileId
      if (valid.length > 0) {
        const newTabs: Tab[] = valid.map((e) => ({
          key: newTabKey(),
          kind: "document" as const,
          fileId: e.fileId,
          title: e.title,
          history: [e.fileId],
          historyIndex: 0,
        }))
        setTabs(newTabs)
        const activeTab = newTabs.find((t) => t.fileId === mappedActiveFileId) ?? newTabs[0]
        setActiveTabKey(activeTab.key)
      } else {
        setTabs([])
        clearDocs()
        setActiveTabKey("")
      }
      sessionHydratedRef.current = true
      if (desktop && activateBackend) {
        await emit(VAULT_ACTIVATED_EVENT, {
          path: activePath,
          generation: loaded.generation,
        } satisfies VaultActivatedPayload).catch((error) =>
          logger.warn("vault_switch.broadcast_failed", { errorType: errorType(error) }),
        )
      }
    } catch (err) {
      if (switchRef.current.requestId === requestId) {
        logger.error("vault_switch.activation_failed", { errorType: errorType(err) })
        const details = err instanceof Error ? err.message : String(err)
        await showErrorMessage(t("errors.vaultOpenFailed", { details })).catch((dialogError) =>
          logger.warn("vault_switch.error_dialog_failed", {
            errorType: errorType(dialogError),
          }),
        )
      }
    } finally {
      if (switchRef.current.requestId === requestId) {
        switchRef.current = { ...switchRef.current, inFlight: false }
      }
    }
  }
  loadVaultRef.current = loadVault

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Every note window follows the vault activated by the app, rather than
  // keeping a hidden independent backend context.
  React.useEffect(() => {
    if (!desktop) return
    let unlisten: (() => void) | undefined
    listen<VaultActivatedPayload>(VAULT_ACTIVATED_EVENT, (event) => {
      if (activationMatchesCurrentVault(event.payload, useVaultStore.getState().vault)) {
        setBackendGeneration(event.payload.generation)
        return
      }
      void loadVaultRef.current(event.payload.path, false)
    })
      .then((dispose) => {
        unlisten = dispose
      })
      .catch((error) =>
        logger.warn("vault_switch.broadcast_listen_failed", { errorType: errorType(error) }),
      )
    return () => unlisten?.()
  }, [desktop, setBackendGeneration])

  // A backgrounded renderer may be suspended before Tiptap's 200 ms serializer
  // timer fires. Run the same ordered editor → autosave flush used by close and
  // vault switching while the page is still eligible to execute JavaScript.
  React.useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return
      void flushAutosaveGeneration(useVaultStore.getState().generation).catch((error) =>
        logger.warn("visibilitychange.autosave_flush_failed", { errorType: errorType(error) }),
      )
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [])

  // A close request must wait for all queues in this renderer. Failed saves
  // already have recovery drafts, so closing remains safe after the flush.
  React.useEffect(() => {
    if (!desktop) return
    let closing = false
    let unlisten: (() => void) | undefined
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        if (closing) return
        closing = true
        try {
          const generation = useVaultStore.getState().generation
          const result = await flushAutosaveGeneration(generation)
          if (!result.flushed) logger.warn("window_close.autosave_recovery_retained")
        } catch (error) {
          logger.warn("window_close.autosave_flush_failed", { errorType: errorType(error) })
        } finally {
          try {
            await getCurrentWindow().destroy()
          } catch (error) {
            // A transient native/permission failure must not make the still-open
            // window permanently ignore subsequent close attempts.
            closing = false
            logger.warn("window_close.failed", { errorType: errorType(error) })
          }
        }
      })
      .then((dispose) => {
        unlisten = dispose
      })
      .catch((error) => logger.warn("window_close.listen_failed", { errorType: errorType(error) }))
    return () => unlisten?.()
  }, [desktop])

  // Link graph: recompute whenever the tree or vault changes.
  React.useEffect(() => {
    if (!vault) {
      setLinkGraph({ nodes: [], edges: [] })
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      if (isTauri()) {
        try {
          const graph = await getLinkGraph(vault)
          if (!cancelled) setLinkGraph(graph)
        } catch {
          /* index may be rebuilding */
        }
        return
      }
      const files = flattenFileItems(treeItems)
      const contents: Record<string, string> = {}
      await Promise.allSettled(
        files.map(async (file) => {
          contents[file.id] =
            useDocStore.getState().openDocs[file.id]?.content ?? (await readFile(file.id))
        }),
      )
      if (!cancelled) setLinkGraph(buildLinkGraph(treeItems, contents, vault))
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // openDocs intentionally excluded: web-mode already reads via openDocsRef; Tauri-mode
    // fetches from SQLite and doesn't need openDocs at all. Removing it prevents this effect
    // from re-running on every keystroke.
  }, [treeItems, vault])

  // Debounced session persistence (tabs + favorites + view-modes + locked + icons).
  // Gated on sessionHydratedRef so loadVault's hydration doesn't echo back.
  React.useEffect(() => {
    if (!ownsPersistence || !vault || !sessionHydratedRef.current) return
    const docTabs = tabs.filter((t) => t.kind === "document")
    const entries = docTabs.map((t) => ({ fileId: t.fileId, title: t.title }))
    const active = docTabs.find((t) => t.key === activeTabKey)
    const timer = setTimeout(() => {
      saveSession({
        schemaVersion: SESSION_SCHEMA_VERSION,
        tabs: entries,
        activeFileId: active?.fileId ?? entries[0]?.fileId ?? "",
        favorites: [...favorites],
        viewModes,
        nestedNotesPlacements,
        locked: [...lockedFileIds],
        icons: iconOverrides,
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [
    vault,
    tabs,
    activeTabKey,
    favorites,
    viewModes,
    nestedNotesPlacements,
    lockedFileIds,
    iconOverrides,
    ownsPersistence,
  ])

  // The Rust watcher is process-wide. Only the main window owns its lifecycle;
  // detached note windows subscribe to the same emitted events below.
  React.useEffect(() => {
    if (!vault || !ownsWatcher) return
    void startVaultWatcher(vault).catch((error) =>
      logger.warn("watcher.start_failed", { errorType: errorType(error) }),
    )
    return () => {
      void stopVaultWatcher().catch((error) =>
        logger.warn("watcher.stop_failed", { errorType: errorType(error) }),
      )
    }
  }, [ownsWatcher, vault])

  // Every window listens for external changes. Open clean buffers are reloaded
  // after the active index refresh; dirty buffers remain untouched until the
  // conflict UI asks the user what to keep.
  React.useEffect(() => {
    if (!vault || !desktop) return

    let unlisten: (() => void) | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const pending = new Map<string, { kind: string; path: string }>()
    const normalize = (path: string) => path.replace(/\\/g, "/")

    listen<{ kind: string; path: string }>("vault-file-changed", (event) => {
      const change = event.payload
      pending.set(`${change.kind}:${normalize(change.path)}`, change)
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(async () => {
        try {
          const changes = [...pending.values()]
          pending.clear()
          const tree = await refreshTree(vault)
          const openDocs = useDocStore.getState().openDocs

          // A rename/move retains its frontmatter ID, so after rebuilding the
          // tree we can update the open tab's path without closing it. macOS
          // reports a move out of the watched vault as `rename`, not `remove`;
          // absence of the stable ID after refresh is therefore the portable
          // external-deletion signal.
          for (const treeChange of planOpenDocumentTreeChanges(openDocs, tree)) {
            const id = treeChange.fileId
            const doc = openDocs[id]
            if (!doc) continue
            if (treeChange.kind === "deleted") {
              const latest = useDocStore.getState().openDocs[id] ?? doc
              if (!latest.externallyDeleted) {
                patchDoc(id, { externallyDeleted: true })
                setExternalConflict({
                  fileId: id,
                  path: latest.path,
                  localContent: latest.content,
                  externalContent: null,
                  sourceTemplate: latest.source,
                })
              }
              continue
            }
            if (treeChange.kind === "relocated") {
              patchDoc(id, { path: treeChange.path, title: treeChange.title })
              void remapRecoveryDraft(id, id, "markdown", treeChange.path)
              void remapRecoveryDraft(doc.path, treeChange.path, "markdown", treeChange.path)
              const conflict = useDocStore.getState().externalConflicts[id]
              if (conflict) {
                setExternalConflict({
                  ...conflict,
                  path: treeChange.path,
                })
              }
            }
          }

          for (const change of changes) {
            for (const [id, doc] of Object.entries(useDocStore.getState().openDocs)) {
              if (normalize(doc.path) !== normalize(change.path)) continue
              const activeConflict = useDocStore.getState().externalConflicts[id]
              // The tree reconciliation above already classified this ID as
              // deleted. Do not turn the expected read failure into a hidden
              // warning while the path remains absent.
              if (activeConflict?.externalContent === null && !findTreeItem(tree, id)) continue
              try {
                const note = await readNote(vault, id)
                const latest = useDocStore.getState().openDocs[id]
                if (!latest) continue
                const currentConflict = useDocStore.getState().externalConflicts[id]
                if (latest.externallyDeleted || currentConflict?.externalContent === null) {
                  patchDoc(id, { externallyDeleted: false })
                  if (note.content === latest.content) {
                    patchDoc(id, {
                      revision: note.revision,
                      source: note.source,
                    })
                    markSaved(id)
                    clearExternalConflict(id)
                  } else {
                    setExternalConflict({
                      fileId: id,
                      path: latest.path,
                      localContent: latest.content,
                      externalContent: note.content,
                      externalRevision: note.revision,
                      sourceTemplate: note.source,
                    })
                  }
                  continue
                }
                if (note.content === latest.content && note.revision === latest.revision) continue
                if (useDocStore.getState().unsavedFileIds.has(id)) {
                  setExternalConflict({
                    fileId: id,
                    path: latest.path,
                    localContent: latest.content,
                    externalContent: note.content,
                    externalRevision: note.revision,
                    sourceTemplate: note.source,
                  })
                  continue
                }
                // Do not replace a buffer if the user started editing during
                // the asynchronous refresh.
                if (!useDocStore.getState().unsavedFileIds.has(id)) {
                  patchDoc(id, {
                    content: note.content,
                    revision: note.revision,
                    source: note.source,
                  })
                  markSaved(id)
                }
              } catch (err) {
                logger.warn("watcher.open_document_reload_failed", { errorType: errorType(err) })
              }
            }
          }
        } catch (err) {
          logger.warn("watcher.refresh_failed", { errorType: errorType(err) })
        }
      }, 300)
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(console.error)

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      pending.clear()
      unlisten?.()
    }
    // refreshTree closes over vault but vault is in the dep array (effect re-runs on change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, vault])

  // Amby-originated saves use an explicit IPC event rather than the filesystem
  // watcher. That makes two renderer windows converge even when watcher own-write
  // suppression intentionally hides the atomic write event.
  React.useEffect(() => {
    if (!vault || !desktop) return

    let unlisten: (() => void) | undefined
    listen<{ noteId: string; revision: string; originWindow: string }>(
      "amby:note-written",
      async (event) => {
        const { noteId, revision, originWindow } = event.payload
        if (originWindow === windowLabel) return
        const document = useDocStore.getState().openDocs[noteId]
        if (!document) return
        try {
          const note = await readNote(vault, noteId)
          // A newer write won the race while this event was in flight; its event
          // will reconcile the buffer instead.
          if (note.revision !== revision) return
          const latest = useDocStore.getState().openDocs[noteId]
          if (!latest) return
          if (useDocStore.getState().unsavedFileIds.has(noteId)) {
            setExternalConflict({
              fileId: noteId,
              path: latest.path,
              localContent: latest.content,
              externalContent: note.content,
              externalRevision: note.revision,
              sourceTemplate: note.source,
            })
            return
          }
          patchDoc(noteId, {
            content: note.content,
            revision: note.revision,
            source: note.source,
          })
          markSaved(noteId)
        } catch (error) {
          logger.warn("note_written.open_document_reload_failed", { errorType: errorType(error) })
        }
      },
    )
      .then((fn) => {
        unlisten = fn
      })
      .catch(console.error)

    return () => unlisten?.()
  }, [desktop, markSaved, patchDoc, setExternalConflict, vault, windowLabel])

  // On mount: hydrate the known-vaults list from workspaces.json, then reopen
  // the last vault if the user has that setting enabled.
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      await useSettingsStore.getState().hydrate()
      const reopen = useSettingsStore.getState().prefs.startup.reopenLastVault
      const file = await loadWorkspaces()
      if (cancelled) return
      setVaults(file.recent)
      workspacesHydrated.current = true
      const startup = planVaultStartup({
        isDesktop: desktop,
        windowLabel,
        lastOpened: file.lastOpened,
        reopenLastVault: reopen,
      })
      if (startup.kind === "activate") void loadVault(startup.path)
      else if (startup.kind === "attach-active") void loadVault(null, false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, windowLabel])

  // Persist the known-vaults list + last-opened after hydration (so we never
  // clobber workspaces.json with the empty initial state).
  React.useEffect(() => {
    if (!ownsPersistence || !workspacesHydrated.current) return
    void saveWorkspaces({
      schemaVersion: WORKSPACES_SCHEMA_VERSION,
      recent: vaults,
      lastOpened: vault,
    })
  }, [ownsPersistence, vaults, vault])

  // ── Derived ─────────────────────────────────────────────────────────────────

  const displayTreeItems = React.useMemo(
    () => applyIconOverrides(treeItems, iconOverrides),
    [treeItems, iconOverrides],
  )

  return {
    treeItems,
    setTreeItems,
    displayTreeItems,
    linkGraph,
    loadVault,
    refreshTree,
    reloadVaultData,
    windowLabel,
  }
}
