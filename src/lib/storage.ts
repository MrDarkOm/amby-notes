import type { TreeItem } from "@/components/workspace/sidebar-tree"
import i18n from "@/lib/i18n"

export interface FileMetadata {
  created?: number
  modified?: number
  word_count: number
}

export interface FrontmatterProperty {
  key: string
  value: string
  valueKind: string
}

export interface NoteProperties {
  hasFrontmatter: boolean
  properties: FrontmatterProperty[]
  parseError?: string
  customProperties: CustomProperty[]
}

export interface CustomProperty {
  id: string
  name: string
  icon: string
  propertyType: string
  value: string
  settings: string
}

export interface SnapshotEntry {
  id: string
  createdAtMs: number
  reason: string
  sizeBytes: number
}

export interface SnapshotText {
  sourcePath: string
  content: string
}

export interface RefactorPreview {
  notes: number
  replacements: number
}

export interface TrashEntry {
  id: string
  originalPath: string
  deletedAtMs: number
  name: string
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

export interface VaultPreflight {
  notes: number
  attachments: number
  malformedFrontmatter: string[]
  userManagedIds: string[]
  duplicateIds: string[]
  plannedIdWrites: string[]
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

/**
 * Tauri's dialog plugin replaces `window.confirm` with an async shim, while
 * the DOM type and existing callers expect a synchronous boolean. Call the
 * supported message command explicitly so destructive actions always wait for
 * the user's choice. Browsers keep using their native confirmation dialog.
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (!isTauri()) {
    return typeof window !== "undefined" ? window.confirm(message) : false
  }
  const result = await invoke<string>("plugin:dialog|message", {
    message,
    title: i18n.t("app.name"),
    kind: "warning",
    buttons: "OkCancel",
  })
  return result === "Ok"
}

// ── Web fallback (localStorage) ─────────────────────────────────────────────

const WEB_VAULT = "web-vault"
const TREE_KEY = "amby:tree"
const FILE_PREFIX = "amby:file:"

function splitWebFrontmatter(
  content: string,
): { envelope: string; yaml: string; body: string } | null {
  const match = /^(---\n)([\s\S]*?)(\n---\n?)/u.exec(content)
  if (!match) return null
  return {
    envelope: match[0],
    yaml: match[2],
    body: content.slice(match[0].length),
  }
}

function webNoteProperties(content: string): NoteProperties {
  const frontmatter = splitWebFrontmatter(content)
  if (!frontmatter) return { hasFrontmatter: false, properties: [], customProperties: [] }
  const properties: FrontmatterProperty[] = []
  for (const line of frontmatter.yaml.split("\n")) {
    if (!line || /^\s/u.test(line) || line.trimStart().startsWith("#")) continue
    const separator = line.indexOf(":")
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "")
    properties.push({ key, value, valueKind: "text" })
  }
  return { hasFrontmatter: true, properties, customProperties: [] }
}

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
      name: i18n.t("defaults.welcome"),
      type: "file" as const,
      icon: "brain" as const,
    },
    {
      id: "web-vault/Notes.md",
      path: "web-vault/Notes.md",
      name: i18n.t("defaults.notes"),
      type: "file" as const,
      icon: "file" as const,
    },
  ]
}

function webDefaultContent(path: string): string {
  if (path.endsWith("Welcome.md")) {
    return i18n.t("defaults.welcomeContent")
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
  return items.map((item) => ({
    ...item,
    id: mapper(item.id),
    path: mapper(item.path ?? item.id),
    children: item.children ? webMapTreeIds(item.children, mapper) : undefined,
  }))
}

function webUpdateItem(
  items: TreeItem[],
  id: string,
  updater: (item: TreeItem) => TreeItem,
): TreeItem[] {
  return items.map((item) => {
    if (item.id === id) return updater(item)
    return {
      ...item,
      children: item.children ? webUpdateItem(item.children, id, updater) : undefined,
    }
  })
}

function webRemoveItem(items: TreeItem[], id: string): { tree: TreeItem[]; item: TreeItem | null } {
  let removed: TreeItem | null = null
  const tree = items
    .filter((item) => {
      if (item.id === id) {
        removed = item
        return false
      }
      return true
    })
    .map((item) => {
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

function webEnsureBundle(notePath: string): {
  notePath: string
  changes: PathChange[]
  tree: TreeItem[]
} {
  const tree = webGetTree()
  const item = webFindItem(tree, notePath)
  if (!item || item.type !== "file") throw new Error(i18n.t("errors.notANote", { path: notePath }))
  if (isBundleMainPath(notePath)) return { notePath, changes: [], tree }

  const stem = pathStem(notePath)
  const newPath = joinPath(joinPath(pathDir(notePath), stem), `${stem}.md`)
  const changes = [{ oldPath: notePath, newPath }]
  webApplyPathChanges(changes)
  const nextTree = webUpdateItem(tree, notePath, (current) => ({
    ...current,
    id: newPath,
    children: current.children ?? [],
  }))
  webSaveTree(nextTree)
  return { notePath: newPath, changes, tree: nextTree }
}

function webAddChild(items: TreeItem[], parentId: string | null, child: TreeItem): TreeItem[] {
  if (!parentId) return [...items, child]
  return webUpdateItem(items, parentId, (item) => ({
    ...item,
    children: [...(item.children ?? []), child],
  }))
}

function webCreateNote(parentPath: string, name: string): FsMutationResult {
  let tree = webGetTree()
  let targetParentId: string | null = null
  let targetDir: string
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
  if (webFindItem(tree, primaryPath))
    throw new Error(i18n.t("errors.noteExists", { path: primaryPath }))

  const child: TreeItem = {
    id: primaryPath,
    path: primaryPath,
    name,
    type: "file",
    icon: "file",
  }
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

/**
 * Start a Rust-side `notify` watcher on the vault directory.
 * The watcher emits `vault-file-changed` Tauri events for external changes
 * (creates / renames / deletes / edits by other apps).  Own writes from the
 * app are suppressed via a self-write guard in Rust.
 * No-op in browser mode (web dev server has no Tauri events).
 */
export async function startVaultWatcher(vaultPath: string): Promise<void> {
  if (isTauri()) return invoke<void>("start_vault_watcher", { vaultPath })
}

/** Stop the active vault watcher (call on vault close or app teardown). */
export async function stopVaultWatcher(): Promise<void> {
  if (isTauri()) return invoke<void>("stop_vault_watcher")
}

export async function loadVaultData(vaultPath: string): Promise<LoadVaultResult> {
  if (isTauri()) return invoke<LoadVaultResult>("load_vault", { vaultPath })
  const tree = webGetTree()
  const notes = flattenWebNotes(tree).map((item) => ({
    id: item.id,
    path: item.path ?? item.id,
    title: item.name,
    wordCount: (localStorage.getItem(FILE_PREFIX + item.id) ?? "").split(/\s+/).filter(Boolean)
      .length,
  }))
  return { tree, notes, sync: { inserted: 0, updated: 0, deleted: 0, warnings: [], pathToId: {} } }
}

export async function preflightVault(vaultPath: string): Promise<VaultPreflight> {
  if (isTauri()) return invoke<VaultPreflight>("preflight_vault", { vaultPath })
  return {
    notes: 0,
    attachments: 0,
    malformedFrontmatter: [],
    userManagedIds: [],
    duplicateIds: [],
    plannedIdWrites: [],
  }
}

export async function applyIdMigration(vaultPath: string): Promise<void> {
  if (isTauri()) await invoke("apply_id_migration", { vaultPath })
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
  const content = await readFile(noteId)
  return splitWebFrontmatter(content)?.body ?? content
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_file", { path, content })
  localStorage.setItem(FILE_PREFIX + path, content)
}

/** Save a unique sibling copy of a conflicted local buffer without overwriting a file. */
export async function saveConflictCopy(path: string, content: string): Promise<string> {
  if (isTauri()) return invoke<string>("save_conflict_copy", { path, content })
  const extensionStart = path.lastIndexOf(".")
  const stem = extensionStart > path.lastIndexOf("/") ? path.slice(0, extensionStart) : path
  const extension = extensionStart > path.lastIndexOf("/") ? path.slice(extensionStart) : ""
  let copyPath = `${stem}.${crypto.randomUUID()}-conflict${extension}`
  while (localStorage.getItem(FILE_PREFIX + copyPath) !== null) {
    copyPath = `${stem}.${crypto.randomUUID()}-conflict${extension}`
  }
  localStorage.setItem(FILE_PREFIX + copyPath, content)
  return copyPath
}

export async function listSnapshots(sourcePath: string): Promise<SnapshotEntry[]> {
  if (isTauri()) return invoke<SnapshotEntry[]>("list_snapshots", { sourcePath })
  return []
}

export async function restoreSnapshot(snapshotId: string): Promise<string> {
  if (isTauri()) return invoke<string>("restore_snapshot", { snapshotId })
  throw new Error(i18n.t("errors.localHistoryDesktopOnly"))
}

export async function readSnapshotText(snapshotId: string): Promise<SnapshotText> {
  if (isTauri()) return invoke<SnapshotText>("read_snapshot_text", { snapshotId })
  throw new Error(i18n.t("errors.localHistoryDesktopOnly"))
}

export async function listTrash(): Promise<TrashEntry[]> {
  if (isTauri()) return invoke<TrashEntry[]>("list_trash")
  return []
}

export async function restoreTrash(trashId: string): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("restore_trash", { trashId })
  throw new Error(i18n.t("errors.trashDesktopOnly"))
}

export async function previewRenameRefactor(
  vaultPath: string,
  path: string,
  newName: string,
): Promise<RefactorPreview> {
  if (isTauri())
    return invoke<RefactorPreview>("preview_rename_refactor", { vaultPath, path, newName })
  return { notes: 0, replacements: 0 }
}

export async function previewMoveRefactor(
  vaultPath: string,
  sourcePath: string,
  targetPath: string,
): Promise<RefactorPreview> {
  if (isTauri())
    return invoke<RefactorPreview>("preview_move_refactor", { vaultPath, sourcePath, targetPath })
  return { notes: 0, replacements: 0 }
}

export async function writeNote(vaultPath: string, noteId: string, content: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_note", { vaultPath, noteId, content })
  const current = await readFile(noteId)
  const frontmatter = splitWebFrontmatter(current)
  return writeFile(noteId, `${frontmatter?.envelope ?? ""}${content}`)
}

export async function createNote(
  vaultPath: string,
  parentPath: string,
  name: string,
): Promise<FsMutationResult> {
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

export async function createCanvasFile(
  vaultPath: string,
  parentPath: string | null,
  name: string,
): Promise<string> {
  if (isTauri()) {
    return invoke<string>("create_canvas", { vaultPath, parentPath: parentPath ?? vaultPath, name })
  }
  // Web fallback: write a standalone .canvas file and register a tree item.
  const tree = webGetTree()
  const parentItem = parentPath ? webFindItem(tree, parentPath) : null
  let targetDir = WEB_VAULT
  let parentFolderId: string | null = null
  if (parentItem?.type === "folder") {
    targetDir = parentItem.path ?? parentItem.id
    parentFolderId = parentItem.id
  } else if (parentItem?.type === "file") {
    targetDir = pathDir(parentItem.path ?? parentItem.id)
  } else if (parentPath && parentPath !== WEB_VAULT) {
    targetDir = parentPath
  }

  const stem = name.trim() || i18n.t("defaults.untitled")
  let path = joinPath(targetDir, `${stem}.canvas`)
  let i = 2
  while (localStorage.getItem(FILE_PREFIX + path) !== null) {
    path = joinPath(targetDir, `${stem}_${i}.canvas`)
    i += 1
  }
  localStorage.setItem(FILE_PREFIX + path, "{}\n")
  const item: TreeItem = {
    id: `canvas:${path}`,
    path,
    name: pathStem(path),
    type: "canvas",
    icon: "canvas",
  }
  webSaveTree(webAddChild(tree, parentFolderId, item))
  return path
}

export async function attachCanvasToNote(
  vaultPath: string,
  canvasPath: string,
): Promise<FsMutationResult> {
  if (isTauri()) {
    return invoke<FsMutationResult>("attach_canvas_to_note", { vaultPath, canvasPath })
  }
  // Web fallback: create a sibling note bundle and move the canvas in as its layer.
  const dir = pathDir(canvasPath)
  const stem = pathStem(canvasPath)
  const content = localStorage.getItem(FILE_PREFIX + canvasPath) ?? "{}\n"

  let name = stem
  let i = 2
  while (webFindItem(webGetTree(), joinPath(dir, `${name}.md`))) {
    name = `${stem}-${i}`
    i += 1
  }
  const createRes = webCreateNote(dir, name)
  const created = createRes.primaryPath ?? joinPath(dir, `${name}.md`)
  const ensured = webEnsureBundle(created)
  const bundleDir = pathDir(ensured.notePath)
  const layerPath = joinPath(bundleDir, `${pathStem(ensured.notePath)}.canvas`)
  localStorage.setItem(FILE_PREFIX + layerPath, content)
  localStorage.removeItem(FILE_PREFIX + canvasPath)
  const removed = webRemoveItem(webGetTree(), `canvas:${canvasPath}`)
  webSaveTree(removed.tree)

  return {
    primaryId: ensured.notePath,
    primaryPath: ensured.notePath,
    pathChanges: [...createRes.pathChanges, ...ensured.changes],
    deletedPaths: [],
    deletedIds: [],
  }
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

export async function unlinkLayer(
  vaultPath: string,
  notePath: string,
  kind: LayerKind,
): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("unlink_layer", { vaultPath, notePath, kind })
  // Web fallback: rename layer key with _ul suffix and lift it out of the bundle dir.
  const dir = pathDir(notePath)
  const parentDir = pathDir(dir)
  const stem = pathStem(notePath)
  const ext = kind === "canvas" ? "canvas" : kind === "sketch" ? "excalidraw" : "md"
  const oldPath =
    kind === "database" ? joinPath(dir, "Metadata.md") : joinPath(dir, `${stem}.${ext}`)
  const newStem = kind === "database" ? `${stem}_metadata_ul` : `${stem}_ul`
  let newPath = joinPath(parentDir, `${newStem}.${ext}`)
  let i = 2
  while (localStorage.getItem(FILE_PREFIX + newPath) !== null) {
    newPath = joinPath(parentDir, `${newStem}_${i}.${ext}`)
    i += 1
  }
  const content = localStorage.getItem(FILE_PREFIX + oldPath)
  if (content === null) throw new Error(i18n.t("errors.layerNotFound", { path: oldPath }))
  localStorage.setItem(FILE_PREFIX + newPath, content)
  localStorage.removeItem(FILE_PREFIX + oldPath)
  return {
    primaryId: null,
    primaryPath: notePath,
    pathChanges: ext === "md" ? [{ oldPath, newPath }] : [],
    deletedPaths: [],
    deletedIds: [],
  }
}

export async function deleteLayer(
  vaultPath: string,
  notePath: string,
  kind: LayerKind,
): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("delete_layer", { vaultPath, notePath, kind })
  const dir = pathDir(notePath)
  const stem = pathStem(notePath)
  const layerPath =
    kind === "database"
      ? joinPath(dir, "Metadata.md")
      : joinPath(dir, `${stem}.${kind === "sketch" ? "excalidraw" : "canvas"}`)
  localStorage.removeItem(FILE_PREFIX + layerPath)
  return {
    primaryId: null,
    primaryPath: notePath,
    pathChanges: [],
    deletedPaths: kind === "database" ? [layerPath] : [],
    deletedIds: [],
  }
}

export async function createLayer(notePath: string, kind: LayerKind): Promise<LayerResult> {
  if (isTauri()) return invoke<LayerResult>("create_layer", { notePath, kind })

  const ensured = webEnsureBundle(notePath)
  const stem = pathStem(ensured.notePath)
  const dir = pathDir(ensured.notePath)
  const layerPath =
    kind === "database"
      ? joinPath(dir, "Metadata.md")
      : joinPath(dir, `${stem}.${kind === "sketch" ? "excalidraw" : "canvas"}`)
  localStorage.setItem(
    FILE_PREFIX + layerPath,
    kind === "database" ? "# Metadata\n\n```amby-db\n[]\n```\n" : "{}\n",
  )
  return { notePath: ensured.notePath, layerPath, kind, pathChanges: ensured.changes }
}

export async function renameItem(
  vaultPath: string,
  path: string,
  newName: string,
): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("rename_item", { vaultPath, path, newName })

  const tree = webGetTree()
  const item = webFindItem(tree, path)
  if (!item) throw new Error(i18n.t("errors.pathNotFound", { path }))

  const oldIds = webCollectFileIds(item)
  const oldPrefix = isBundleMainPath(path) ? pathDir(path) : path
  const newPrefix = isBundleMainPath(path)
    ? joinPath(pathDir(pathDir(path)), newName)
    : joinPath(pathDir(path), item.type === "file" ? `${newName}.md` : newName)
  const primaryPath = isBundleMainPath(path) ? joinPath(newPrefix, `${newName}.md`) : newPrefix

  const pathChanges = oldIds.map((oldPath) => ({
    oldPath,
    newPath: oldPath === path ? primaryPath : oldPath.replace(oldPrefix, newPrefix),
  }))
  webApplyPathChanges(pathChanges)

  const nextTree = webUpdateItem(tree, path, (current) => {
    const updated = webMapTreeIds([current], (id) => {
      if (id === path) return primaryPath
      return id.replace(oldPrefix, newPrefix)
    })[0]
    return { ...updated, name: newName }
  })
  webSaveTree(nextTree)

  return { primaryId: primaryPath, primaryPath, pathChanges, deletedPaths: [], deletedIds: [] }
}

export async function moveItem(
  vaultPath: string,
  sourcePath: string,
  targetPath: string,
): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("move_item", { vaultPath, sourcePath, targetPath })

  let tree = webGetTree()
  const source = webFindItem(tree, sourcePath)
  const target = targetPath === vaultPath ? null : webFindItem(tree, targetPath)
  if (!source || (targetPath !== vaultPath && !target))
    throw new Error(i18n.t("errors.moveTargetNotFound"))

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
  if (!removed.item) throw new Error(i18n.t("errors.sourceNotFound", { path: sourcePath }))
  const sourceRoot = isBundleMainPath(sourcePath) ? pathDir(sourcePath) : sourcePath
  const sourceRootName = pathBase(sourceRoot)
  const newRoot = joinPath(targetDir, sourceRootName)
  const primaryPath = isBundleMainPath(sourcePath)
    ? joinPath(newRoot, pathBase(sourcePath))
    : joinPath(targetDir, pathBase(sourcePath))
  const sourceIds = webCollectFileIds(removed.item)
  const sourceChanges = sourceIds.map((oldPath) => ({
    oldPath,
    newPath: oldPath === sourcePath ? primaryPath : oldPath.replace(sourceRoot, newRoot),
  }))
  webApplyPathChanges(sourceChanges)

  const moved = {
    ...webMapTreeIds([removed.item], (id) => {
      if (id === sourcePath) return primaryPath
      return id.replace(sourceRoot, newRoot)
    })[0],
  }
  const nextTree = webAddChild(removed.tree, targetParentId, moved)
  webSaveTree(nextTree)

  return {
    primaryId: primaryPath,
    primaryPath,
    pathChanges: [...pathChanges, ...sourceChanges],
    deletedPaths: [],
    deletedIds: [],
  }
}

export async function deleteItem(vaultPath: string, path: string): Promise<FsMutationResult> {
  if (isTauri()) return invoke<FsMutationResult>("delete_item", { vaultPath, path })

  const tree = webGetTree()
  const removed = webRemoveItem(tree, path)
  const deletedPaths = removed.item ? webCollectFileIds(removed.item) : [path]
  for (const deletedPath of deletedPaths) localStorage.removeItem(FILE_PREFIX + deletedPath)
  webSaveTree(removed.tree)
  return {
    primaryId: null,
    primaryPath: null,
    pathChanges: [],
    deletedPaths,
    deletedIds: deletedPaths,
  }
}

export async function getNoteMetadata(vaultPath: string, noteId: string): Promise<FileMetadata> {
  if (isTauri()) return invoke<FileMetadata>("get_note_metadata", { vaultPath, noteId })
  const content = localStorage.getItem(FILE_PREFIX + noteId) ?? ""
  return { word_count: content.split(/\s+/).filter(Boolean).length }
}

export async function getNoteProperties(
  vaultPath: string,
  noteId: string,
): Promise<NoteProperties> {
  if (isTauri()) return invoke<NoteProperties>("get_note_properties", { vaultPath, noteId })
  const result = webNoteProperties(localStorage.getItem(FILE_PREFIX + noteId) ?? "")
  try {
    result.customProperties = JSON.parse(
      localStorage.getItem(`amby:custom-properties:${noteId}`) ?? "[]",
    ) as CustomProperty[]
  } catch {
    result.customProperties = []
  }
  return result
}

export async function upsertCustomProperty(
  vaultPath: string,
  noteId: string,
  property: CustomProperty,
): Promise<CustomProperty> {
  if (isTauri())
    return invoke<CustomProperty>("upsert_custom_property", { vaultPath, noteId, property })
  const current = (await getNoteProperties("", noteId)).customProperties
  const saved = { ...property, id: property.id || crypto.randomUUID() }
  const index = current.findIndex((item) => item.id === saved.id)
  if (index >= 0) current[index] = saved
  else current.push(saved)
  localStorage.setItem(`amby:custom-properties:${noteId}`, JSON.stringify(current))
  return saved
}

export async function deleteCustomProperty(
  vaultPath: string,
  noteId: string,
  propertyId: string,
): Promise<void> {
  if (isTauri()) {
    await invoke("delete_custom_property", { vaultPath, noteId, propertyId })
    return
  }
  const current = (await getNoteProperties("", noteId)).customProperties.filter(
    (property) => property.id !== propertyId,
  )
  localStorage.setItem(`amby:custom-properties:${noteId}`, JSON.stringify(current))
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

export interface VaultTagEntry {
  tag: string
  notes: Array<{
    id: string
    path: string
    title: string
    modified: number | null
    wordCount: number
  }>
}

export async function listTags(vaultPath: string): Promise<VaultTagEntry[]> {
  if (isTauri()) return invoke<VaultTagEntry[]>("list_tags", { vaultPath })
  return []
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

/**
 * Save text to a user-chosen file. Uses the native save dialog under Tauri
 * (a programmatic <a download> click silently fails in the webview); falls
 * back to a browser blob download in web-only dev mode. Returns the saved
 * path (Tauri) or null (cancelled / web).
 */
export async function exportTextFile(
  contents: string,
  defaultName: string,
): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>("export_text_file", { contents, defaultName })
  }
  const blob = new Blob([contents], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = defaultName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return null
}

/** Open a user-chosen text file and return its contents, or null if cancelled. */
export async function importTextFile(): Promise<string | null> {
  if (isTauri()) {
    return invoke<string | null>("import_text_file", {})
  }
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.onchange = async () => {
      const file = input.files?.[0]
      resolve(file ? await file.text() : null)
    }
    input.click()
  })
}

// ── Tiered settings storage ─────────────────────────────────────────────────
//
// Generic JSON read/write over two roots (the domain layer decides what file
// names and shapes live where):
//  • Global  — {local_data_dir}/Amby/<file>           via read/write_app_data
//  • Vault   — {vault}/.amby/<rel>                     via read/write/delete_vault_meta
//             (also covers per-note block sidecars: blocks/<id>.json)
//
// Web-only dev mode (no backend) mirrors both into localStorage. The browser
// only ever has a single web vault, so vault-meta is keyed without a vault id.

const GLOBAL_WEB_PREFIX = "amby:g:"
const VAULT_WEB_PREFIX = "amby:vmeta:"

async function readGlobalRaw(file: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("read_app_data", { rel: file })
  return localStorage.getItem(GLOBAL_WEB_PREFIX + file)
}

async function writeGlobalRaw(file: string, contents: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_app_data", { rel: file, contents })
  localStorage.setItem(GLOBAL_WEB_PREFIX + file, contents)
}

async function readVaultRaw(rel: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("read_vault_meta", { rel })
  return localStorage.getItem(VAULT_WEB_PREFIX + rel)
}

async function writeVaultRaw(rel: string, contents: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_vault_meta", { rel, contents })
  localStorage.setItem(VAULT_WEB_PREFIX + rel, contents)
}

/** Load + parse a global JSON file, returning `fallback` if absent or corrupt. */
export async function loadGlobalJSON<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readGlobalRaw(file)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** Serialize + write a global JSON file (fire-and-forget; errors swallowed). */
export async function saveGlobalJSON(file: string, data: unknown): Promise<void> {
  try {
    await writeGlobalRaw(file, JSON.stringify(data, null, 2))
  } catch {
    /* storage unavailable */
  }
}

/** Load + parse a per-vault JSON file, returning `fallback` if absent or corrupt. */
export async function loadVaultJSON<T>(rel: string, fallback: T): Promise<T> {
  try {
    const raw = await readVaultRaw(rel)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** Serialize + write a per-vault JSON file (fire-and-forget; errors swallowed). */
export async function saveVaultJSON(rel: string, data: unknown): Promise<void> {
  try {
    await writeVaultRaw(rel, JSON.stringify(data, null, 2))
  } catch {
    /* storage unavailable */
  }
}

/** Delete a per-vault metadata file (no-op if missing). */
export async function deleteVaultMeta(rel: string): Promise<void> {
  try {
    if (isTauri()) {
      await invoke<void>("delete_vault_meta", { rel })
      return
    }
    localStorage.removeItem(VAULT_WEB_PREFIX + rel)
  } catch {
    /* storage unavailable */
  }
}

/** True when a global config file has never been written (fresh / pre-tier). */
export async function globalFileMissing(file: string): Promise<boolean> {
  return (await readGlobalRaw(file)) === null
}

/** True when a per-vault metadata file has never been written. */
export async function vaultFileMissing(rel: string): Promise<boolean> {
  return (await readVaultRaw(rel)) === null
}
