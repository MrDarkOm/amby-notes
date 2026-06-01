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
  getLinkGraph,
  startVaultWatcher,
  stopVaultWatcher,
  type LinkGraph,
} from "@/lib/storage"
import { listen } from "@tauri-apps/api/event"

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

  const { setDoc, clearDocs } = useDocStore.getState()
  const { setTabs, setActiveTabKey } = useTabsStore.getState()

  // For the session persist effect we need reactive reads.
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabKey = useTabsStore((s) => s.activeTabKey)
  const favorites = useViewStateStore((s) => s.favorites)
  const viewModes = useViewStateStore((s) => s.viewModes)
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

  // ── loadVault ───────────────────────────────────────────────────────────────

  async function loadVault(path: string) {
    try {
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
          readNote(path, e.fileId)
            .then((content) => {
              setDoc(e.fileId, {
                id: e.fileId,
                title: e.title,
                content,
                modified: "",
                wordCount: 0,
                path: item?.path ?? e.fileId,
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
        locked: [...lockedFileIds],
        icons: iconOverrides,
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [vault, tabs, activeTabKey, favorites, viewModes, lockedFileIds, iconOverrides])

  // Vault watcher: start the Rust notify watcher when a vault is open and
  // debounce-refresh the tree on external file changes.
  React.useEffect(() => {
    if (!vault || !isTauri()) return

    startVaultWatcher(vault).catch(console.error)

    let unlisten: (() => void) | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    listen<{ kind: string; path: string }>("vault-file-changed", () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(async () => {
        try {
          await refreshTree(vault)
        } catch {
          /* vault may be temporarily inaccessible */
        }
      }, 300)
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(console.error)

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
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

  return { treeItems, setTreeItems, displayTreeItems, linkGraph, loadVault, refreshTree }
}
