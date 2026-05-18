import type { TreeItem } from "@/components/workspace/sidebar-tree"

export interface FileMetadata {
  created?: number
  modified?: number
  word_count: number
}

export interface IndexedNote {
  id: string
  path: string
  title: string
  modified?: number
  wordCount: number
}

export interface SyncReport {
  inserted: number
  updated: number
  deleted: number
  warnings: string[]
  pathToId: Record<string, string>
}

export interface LoadVaultResult {
  tree: TreeItem[]
  notes: IndexedNote[]
  sync: SyncReport
}

export interface PathChange {
  oldPath: string
  newPath: string
}

export interface FsMutationResult {
  primaryId?: string | null
  primaryPath?: string | null
  pathChanges: PathChange[]
  deletedPaths: string[]
  deletedIds?: string[]
}

export type LayerKind = "canvas" | "database" | "sketch"

export interface LayerResult {
  notePath: string
  layerPath: string
  kind: LayerKind
  pathChanges: PathChange[]
}

export interface NoteLayers {
  canvas: boolean
  sketch: boolean
  database: boolean
}

export interface LinkGraphNode {
  id: string
  label: string
  unresolved?: boolean
}

export interface LinkGraphEdge {
  source: string
  target: string
  label: string
  unresolved?: boolean
}

export interface LinkGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core")
  return tauriInvoke<T>(cmd, args)
}

// ── Web fallback (localStorage) ─────────────────────────────────────────────

const WEB_VAULT = "web-vault"
const TREE_KEY = "amby:tree"
const FILE_PREFIX = "amby:file:"

function pathDir(path: string): string {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/")
  return idx === -1 ? "" : path.slice(0, idx)
}

function pathBase(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path
}

function pathStem(path: string): string {
  return pathBase(path).replace(/\.[^.]+$/u, "")
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/$/u, "")}/${child}`
}

function isBundleMainPath(path: string): boolean {
  return path.endsWith(".md") && pathBase(pathDir(path)) === pathStem(path)
}

function webGetTree(): TreeItem[] {
  try {
    const stored = localStorage.getItem(TREE_KEY)
    return stored ? JSON.parse(stored) : webDefaultTree()
  } catch {
    return webDefaultTree()
  }
}

function webSaveTree(tree: TreeItem[]) {
  localStorage.setItem(TREE_KEY, JSON.stringify(tree))
}

function webDefaultTree(): TreeItem[] {
  return [
    {
      id: "web-vault/Welcome.md",
      path: "web-vault/Welcome.md",
      name: "Welcome",
      type: "file" as const,
      icon: "brain" as const,
    },
    {
      id: "web-vault/Notes.md",
      path: "web-vault/Notes.md",
      name: "Notes",
      type: "file" as const,
      icon: "file" as const,
    },
  ]
}

function webDefaultContent(path: string): string {
  if (path.endsWith("Welcome.md")) {
    return "# Welcome to Amby Notes\n\nThis is a web preview. Open the desktop app to save notes to your filesystem.\n\nStart writing your thoughts here..."
  }
  return ""
}

function webFindItem(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item
    const found = item.children ? webFindItem(item.children, id) : null
    if (found) return found
  }
  return null
}

function webMapTreeIds(items: TreeItem[], mapper: (id: string) => string): TreeItem[] {
  return items.map(item => ({
    ...item,
    id: mapper(item.id),
    path: mapper(item.path ?? item.id),
    children: item.children ? webMapTreeIds(item.children, mapper) : undefined,
  }))
}

function webUpdateItem(items: TreeItem[], id: string, updater: (item: TreeItem) => TreeItem): TreeItem[] {
  return items.map(item => {
    if (item.id === id) return updater(item)
    return { ...item, children: item.children ? webUpdateItem(item.children, id, updater) : undefined }
  })
}

function webRemoveItem(items: TreeItem[], id: string): { tree: TreeItem[]; item: TreeItem | null } {
  let removed: TreeItem | null = null
  const tree = items
    .filter(item => {
      if (item.id === id) {
        removed = item
        return false
      }
      return true
    })
    .map(item => {
      if (!item.children) return item
      const result = webRemoveItem(item.children, id)
      if (result.item) removed = result.item
      return { ...item, children: result.tree }
    })
  return { tree, item: removed }
}

function webCollectFileIds(item: TreeItem): string[] {
  const ids = item.type === "file" ? [item.id] : []
  for (const child of item.children ?? []) ids.push(...webCollectFileIds(child))
  return ids
}

function webMoveFileContent(oldPath: string, newPath: string) {
  if (!oldPath || !newPath || oldPath === newPath) return
  const content = localStorage.getItem(FILE_PREFIX + oldPath) ?? webDefaultContent(oldPath)
  localStorage.setItem(FILE_PREFIX + newPath, content)
  localStorage.removeItem(FILE_PREFIX + oldPath)
}

function webApplyPathChanges(changes: PathChange[]) {
  for (const change of changes) {
    if (change.oldPath) webMoveFileContent(change.oldPath, change.newPath)
  }
}

function webEnsureBundle(notePath: string): { notePath: string; changes: PathChange[]; tree: TreeItem[] } {
  const tree = webGetTree()
  const item = webFindItem(tree, notePath)
  if (!item || item.type !== "file") throw new Error(`Not a note: ${notePath}`)
  if (isBundleMainPath(notePath)) return { notePath, changes: [], tree }

  const stem = pathStem(notePath)
  const newPath = joinPath(joinPath(pathDir(notePath), stem), `${stem}.md`)
  const changes = [{ oldPath: notePath, newPath }]
  webApplyPathChanges(changes)
  const nextTree = webUpdateItem(tree, notePath, current => ({ ...current, id: newPath, children: current.children ?? [] }))
  webSaveTree(nextTree)
  return { notePath: newPath, changes, tree: nextTree }
}

function webAddChild(items: TreeItem[], parentId: string | null, child: TreeItem): TreeItem[] {
  if (!parentId) return [...items, child]
  return webUpdateItem(items, parentId, item => ({
    ...item,
    children: [...(item.children ?? []), child],
  }))
}

function webCreateNote(parentPath: string, name: string): FsMutationResult {
  let tree = webGetTree()
  let targetParentId: string | null = null
  let targetDir = parentPath
  const parent = webFindItem(tree, parentPath)
  const pathChanges: PathChange[] = []

  if (parent?.type === "file") {
    const ensured = webEnsureBundle(parentPath)
    tree = ensured.tree
    pathChanges.push(...ensured.changes)
    targetParentId = ensured.notePath
    targetDir = pathDir(ensured.notePath)
  } else if (parent?.type === "folder") {
    targetParentId = parentPath
    targetDir = parentPath
  } else {
    targetDir = parentPath
  }

  const primaryPath = joinPath(targetDir, `${name}.md`)
  if (webFindItem(tree, primaryPath)) throw new Error(`Note already exists: ${primaryPath}`)

  const child: TreeItem = { id: primaryPath, path: primaryPath, name, type: "file", icon: "file" }
  const nextTree = webAddChild(tree, targetParentId, child)
  localStorage.setItem(FILE_PREFIX + primaryPath, "")
  webSaveTree(nextTree)

  return {
    primaryId: primaryPath,
    primaryPath,
    pathChanges: [...pathChanges, { oldPath: "", newPath: primaryPath }],
    deletedPaths: [],
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function openVault(): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("open_vault")
  return WEB_VAULT
}

export async function loadVaultData(vaultPath: string): Promise<LoadVaultResult> {
  if (isTauri()) return invoke<LoadVaultResult>("load_vault", { vaultPath })
  const tree = webGetTree()
  const notes = flattenWebNotes(tree).map(item => ({
    id: item.id,
    path: item.path ?? item.id,
    title: item.name,
    wordCount: (localStorage.getItem(FILE_PREFIX + item.id) ?? "").split(/\s+/).filter(Boolean).length,
  }))
  return { tree, notes, sync: { inserted: 0, updated: 0, deleted: 0, warnings: [], pathToId: {} } }
}

export async function listFiles(vaultPath: string): Promise<TreeItem[]> {
  if (isTauri()) return invoke<TreeItem[]>("list_files", { vaultPath })
  return webGetTree()
}

function flattenWebNotes(items: TreeItem[]): TreeItem[] {
  const notes: TreeItem[] = []
  for (const item of items) {
    if (item.type === "file") notes.push(item)
    if (item.children) notes.push(...flattenWebNotes(item.children))
  }
  return notes
}

export async function readFile(path: string): Promise<string> {
  if (isTauri()) return invoke<string>("read_file", { path })
  return localStorage.getItem(FILE_PREFIX + path) ?? webDefaultContent(path)
}

export async function readNote(vaultPath: string, noteId: string): Promise<string> {
  if (isTauri()) return invoke<string>("read_note", { vaultPath, noteId })
  return readFile(noteId)
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_file", { path, content })
  localStorage.setItem(FILE_PREFIX + path, content)
}

export async function writeNote(vaultPath: string, noteId: string, content: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_note", { vaultPath, noteId, content })
  return writeFile(noteId, content)
}

export async function createNote(vaultPath: string, parentPath: string, name: string): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("create_note", { vaultPath, parentPath, name })
  return webCreateNote(parentPath, name)
}

export async function createFile(vaultPath: string, name: string): Promise<string> {
  const result = await createNote(vaultPath, vaultPath, name)
  return result.primaryPath ?? joinPath(vaultPath, `${name}.md`)
}

export async function createFolder(vaultPath: string, name: string): Promise<string> {
  const path = joinPath(vaultPath, name)
  if (isTauri()) {
    await invoke<void>("create_folder", { path })
  } else {
    const tree = webGetTree()
    const parent = webFindItem(tree, vaultPath)
    const folder: TreeItem = { id: path, path, name, type: "folder", icon: "folder", children: [] }
    webSaveTree(webAddChild(tree, parent?.type === "folder" ? vaultPath : null, folder))
  }
  return path
}

export async function noteLayers(notePath: string): Promise<NoteLayers> {
  if (isTauri()) return invoke<NoteLayers>("note_layers", { notePath })
  const stem = pathStem(notePath)
  const dir = pathDir(notePath)
  if (pathBase(dir) !== stem) return { canvas: false, sketch: false, database: false }
  return {
    canvas: localStorage.getItem(FILE_PREFIX + joinPath(dir, `${stem}.canvas`)) !== null,
    sketch: localStorage.getItem(FILE_PREFIX + joinPath(dir, `${stem}.excalidraw`)) !== null,
    database: localStorage.getItem(FILE_PREFIX + joinPath(dir, "Metadata.md")) !== null,
  }
}

export async function createLayer(notePath: string, kind: LayerKind): Promise<LayerResult> {
  if (isTauri()) return invoke<LayerResult>("create_layer", { notePath, kind })

  const ensured = webEnsureBundle(notePath)
  const stem = pathStem(ensured.notePath)
  const dir = pathDir(ensured.notePath)
  const layerPath = kind === "database"
    ? joinPath(dir, "Metadata.md")
    : joinPath(dir, `${stem}.${kind === "sketch" ? "excalidraw" : "canvas"}`)
  localStorage.setItem(FILE_PREFIX + layerPath, kind === "database" ? "# Metadata\n\n```amby-db\n[]\n```\n" : "{}\n")
  return { notePath: ensured.notePath, layerPath, kind, pathChanges: ensured.changes }
}

export async function renameItem(vaultPath: string, path: string, newName: string): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("rename_item", { vaultPath, path, newName })

  const tree = webGetTree()
  const item = webFindItem(tree, path)
  if (!item) throw new Error(`Path not found: ${path}`)

  const oldIds = webCollectFileIds(item)
  const oldPrefix = isBundleMainPath(path) ? pathDir(path) : path
  const newPrefix = isBundleMainPath(path)
    ? joinPath(pathDir(pathDir(path)), newName)
    : joinPath(pathDir(path), item.type === "file" ? `${newName}.md` : newName)
  const primaryPath = isBundleMainPath(path)
    ? joinPath(newPrefix, `${newName}.md`)
    : newPrefix

  const pathChanges = oldIds.map(oldPath => ({
    oldPath,
    newPath: oldPath === path
      ? primaryPath
      : oldPath.replace(oldPrefix, newPrefix),
  }))
  webApplyPathChanges(pathChanges)

  const nextTree = webUpdateItem(tree, path, current => {
    const updated = webMapTreeIds([current], id => {
      if (id === path) return primaryPath
      return id.replace(oldPrefix, newPrefix)
    })[0]
    return { ...updated, name: newName }
  })
  webSaveTree(nextTree)

  return { primaryId: primaryPath, primaryPath, pathChanges, deletedPaths: [], deletedIds: [] }
}

export async function moveItem(vaultPath: string, sourcePath: string, targetPath: string): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("move_item", { vaultPath, sourcePath, targetPath })

  let tree = webGetTree()
  const source = webFindItem(tree, sourcePath)
  const target = targetPath === vaultPath ? null : webFindItem(tree, targetPath)
  if (!source || (targetPath !== vaultPath && !target)) throw new Error("Move source or target not found")

  const pathChanges: PathChange[] = []
  let targetParentId: string | null = null
  let targetDir = vaultPath
  if (target) {
    targetParentId = targetPath
    targetDir = target.type === "file" ? pathDir(targetPath) : targetPath
  }
  if (target?.type === "file") {
    const ensured = webEnsureBundle(targetPath)
    tree = ensured.tree
    pathChanges.push(...ensured.changes)
    targetParentId = ensured.notePath
    targetDir = pathDir(ensured.notePath)
  }

  const removed = webRemoveItem(tree, sourcePath)
  if (!removed.item) throw new Error(`Source not found: ${sourcePath}`)
  const sourceRoot = isBundleMainPath(sourcePath) ? pathDir(sourcePath) : sourcePath
  const sourceRootName = pathBase(sourceRoot)
  const newRoot = joinPath(targetDir, sourceRootName)
  const primaryPath = isBundleMainPath(sourcePath)
    ? joinPath(newRoot, pathBase(sourcePath))
    : joinPath(targetDir, pathBase(sourcePath))
  const sourceIds = webCollectFileIds(removed.item)
  const sourceChanges = sourceIds.map(oldPath => ({
    oldPath,
    newPath: oldPath === sourcePath ? primaryPath : oldPath.replace(sourceRoot, newRoot),
  }))
  webApplyPathChanges(sourceChanges)

  const moved = {
    ...webMapTreeIds([removed.item], id => {
      if (id === sourcePath) return primaryPath
      return id.replace(sourceRoot, newRoot)
    })[0],
  }
  const nextTree = webAddChild(removed.tree, targetParentId, moved)
  webSaveTree(nextTree)

  return { primaryId: primaryPath, primaryPath, pathChanges: [...pathChanges, ...sourceChanges], deletedPaths: [], deletedIds: [] }
}

export async function deleteItem(vaultPath: string, path: string): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("delete_item", { vaultPath, path })

  const tree = webGetTree()
  const removed = webRemoveItem(tree, path)
  const deletedPaths = removed.item ? webCollectFileIds(removed.item) : [path]
  for (const deletedPath of deletedPaths) localStorage.removeItem(FILE_PREFIX + deletedPath)
  webSaveTree(removed.tree)
  return { primaryId: null, primaryPath: null, pathChanges: [], deletedPaths, deletedIds: deletedPaths }
}

export async function getNoteMetadata(vaultPath: string, noteId: string): Promise<FileMetadata> {
  if (isTauri()) return invoke<FileMetadata>("get_note_metadata", { vaultPath, noteId })
  const content = localStorage.getItem(FILE_PREFIX + noteId) ?? ""
  return { word_count: content.split(/\s+/).filter(Boolean).length }
}

export async function getFileMetadata(path: string): Promise<FileMetadata> {
  if (isTauri()) return invoke<FileMetadata>("get_file_metadata", { path })
  const content = localStorage.getItem(FILE_PREFIX + path) ?? ""
  return { word_count: content.split(/\s+/).filter(Boolean).length }
}

export async function getLinkGraph(vaultPath: string): Promise<LinkGraph> {
  if (isTauri()) return invoke<LinkGraph>("get_link_graph", { vaultPath })
  return { nodes: [], edges: [] }
}

export async function openInExplorer(path: string): Promise<void> {
  if (!isTauri()) return
  await invoke<void>("open_in_explorer", { path })
}

export interface ImportedAsset {
  relPath: string
  absPath: string
  fileName: string
  kind: "image" | "file"
}

export async function pickAssetFile(imagesOnly: boolean): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>("pick_asset_file", { imagesOnly })
}

export async function importAsset(
  vaultPath: string,
  notePath: string,
  sourcePath: string,
): Promise<ImportedAsset | null> {
  if (!isTauri()) return null
  return invoke<ImportedAsset>("import_asset", { vaultPath, notePath, sourcePath })
}

export async function importAssetBytes(
  vaultPath: string,
  notePath: string,
  bytes: Uint8Array,
  suggestedExt: string,
): Promise<ImportedAsset | null> {
  if (!isTauri()) return null
  return invoke<ImportedAsset>("import_asset_bytes", {
    vaultPath,
    notePath,
    bytes: Array.from(bytes),
    suggestedExt,
  })
}

export async function toAssetUrl(absPath: string): Promise<string> {
  if (!isTauri()) return absPath
  const { convertFileSrc } = await import("@tauri-apps/api/core")
  return convertFileSrc(absPath)
}
