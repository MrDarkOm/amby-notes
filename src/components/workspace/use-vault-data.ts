import * as React from "react"
import { useVaultStore } from "./use-vault-store"
import { useDocStore } from "./use-doc-store"
import { useTabsStore, type Tab } from "./use-tabs-store"
import { useViewStateStore } from "./use-view-state-store"
import { useSettingsStore } from "./use-settings-store"
import { loadSession, loadWorkspaces, saveSession, saveWorkspaces } from "./app-config"
import { applySessionRemap } from "./workspace-mutations"
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
  preflightVault,
  applyIdMigration,
  getLinkGraph,
  getNoteMetadata,
  getNoteProperties,
  startVaultWatcher,
  stopVaultWatcher,
  confirmAction,
  type LinkGraph,
} from "@/lib/storage"
import { listen } from "@tauri-apps/api/event"
import { errorType, logger } from "@/lib/logger"

/**
 * Owns the vault tree, link graph, session persistence, and the Rust-side
 * file watcher. Returns the handful of values that the Workspace orchestrator
 * and downstream handlers need to read.
 *
 * Collaborates with useVaultStore, useDocStore, useTabsStore,
 * useViewStateStore, and useSettingsStore but does not own them.
 */
export function useVaultData() {
  const vault = useVaultStore((s) => s.vault)
  const vaults = useVaultStore((s) => s.vaults)
  const { setVault, setVaults } = useVaultStore.getState()

  const { setDoc, patchDoc, markSaved, setExternalConflict, clearDocs } = useDocStore.getState()
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
    const loaded = await loadVaultData(path)
    setTreeItems(loaded.tree)
    return loaded.tree
  }

  /** Re-scan the vault and clear the rendered link graph while its index rebuilds. */
  async function reloadVaultData(): Promise<void> {
    if (!vault) return
    setLinkGraph({ nodes: [], edges: [] })
    await refreshTree(vault)
  }

  // ── loadVault ───────────────────────────────────────────────────────────────

  async function loadVault(path: string) {
    try {
      if (isTauri()) {
        const preflight = await preflightVault(path)
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
      const loaded = await loadVaultData(path)
      const tree = loaded.tree
      const pathToId = loaded.sync.pathToId ?? {}
      const allIds = flattenTree(tree)
      setVault(path)
      setTreeItems(tree)
      addVaultToList(path)

      // Suppress session persistence while restoring state so we don't
      // immediately clobber the just-read session.json with empty state.
      sessionHydratedRef.current = false
      const session = await loadSession(path)

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
        // Pre-load documents for all restored tabs in the background.
        valid.forEach((e) => {
          const item = findTreeItem(tree, e.fileId)
          Promise.all([
            readNote(path, e.fileId),
            getNoteMetadata(path, e.fileId),
            getNoteProperties(path, e.fileId),
          ])
            .then(([content, metadata, noteProperties]) => {
              setDoc(e.fileId, {
                id: e.fileId,
                title: e.title,
                content,
                created: metadata.created
                  ? new Date(metadata.created * 1000).toLocaleString()
                  : "—",
                modified: metadata.modified
                  ? new Date(metadata.modified * 1000).toLocaleString()
                  : "—",
                wordCount: metadata.word_count,
                path: item?.path ?? e.fileId,
                noteProperties,
              })
            })
            .catch(() => {})
        })
      } else {
        setTabs([])
        clearDocs()
        setActiveTabKey("")
      }
      sessionHydratedRef.current = true
    } catch (err) {
      console.error("Failed to load vault:", err)
    }
  }

  // ── Effects ─────────────────────────────────────────────────────────────────

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
    if (!vault || !sessionHydratedRef.current) return
    const docTabs = tabs.filter((t) => t.kind === "document")
    const entries = docTabs.map((t) => ({ fileId: t.fileId, title: t.title }))
    const active = docTabs.find((t) => t.key === activeTabKey)
    const timer = setTimeout(() => {
      saveSession({
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
  ])

  // Vault watcher: start the Rust notify watcher when a vault is open and
  // debounce-refresh the tree on external file changes. Open clean buffers are
  // reloaded after the index refresh; dirty buffers are deliberately left alone
  // until the conflict UI can ask the user what to keep.
  React.useEffect(() => {
    if (!vault || !isTauri()) return

    startVaultWatcher(vault).catch(console.error)

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
          // tree we can update the open tab's path without closing it.
          for (const [id, doc] of Object.entries(openDocs)) {
            const item = findTreeItem(tree, id)
            if (item?.type === "file" && item.path !== doc.path) {
              patchDoc(id, { path: item.path, title: item.name })
            }
          }

          for (const change of changes) {
            for (const [id, doc] of Object.entries(useDocStore.getState().openDocs)) {
              if (normalize(doc.path) !== normalize(change.path)) continue
              if (change.kind === "remove") {
                const latest = useDocStore.getState().openDocs[id] ?? doc
                setExternalConflict({
                  fileId: id,
                  path: latest.path,
                  localContent: latest.content,
                  externalContent: null,
                })
                continue
              }
              try {
                const content = await readNote(vault, id)
                const latest = useDocStore.getState().openDocs[id]
                if (!latest || content === latest.content) continue
                if (useDocStore.getState().unsavedFileIds.has(id)) {
                  setExternalConflict({
                    fileId: id,
                    path: latest.path,
                    localContent: latest.content,
                    externalContent: content,
                  })
                  continue
                }
                // Do not replace a buffer if the user started editing during
                // the asynchronous refresh.
                if (!useDocStore.getState().unsavedFileIds.has(id)) {
                  patchDoc(id, { content })
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
      stopVaultWatcher().catch(console.error)
    }
    // refreshTree closes over vault but vault is in the dep array (effect re-runs on change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault])

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
      if (file.lastOpened && reopen) loadVault(file.lastOpened)
      else if (!isTauri()) loadVault("web-vault")
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist the known-vaults list + last-opened after hydration (so we never
  // clobber workspaces.json with the empty initial state).
  React.useEffect(() => {
    if (!workspacesHydrated.current) return
    saveWorkspaces({ recent: vaults, lastOpened: vault })
  }, [vaults, vault])

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
  }
}
