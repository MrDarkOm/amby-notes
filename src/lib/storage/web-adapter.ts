import i18n from "@/lib/i18n"
import type { StoragePort } from "./port"
import type {
  CredentialInfo,
  CustomProperty,
  FileMetadata,
  FrontmatterProperty,
  FsMutationResult,
  IdMigrationRecovery,
  IdMigrationRecoveryAction,
  ImportedAsset,
  LayerKind,
  LayerResult,
  LinkGraph,
  LoadVaultResult,
  NoteLayers,
  NoteProperties,
  PathChange,
  RefactorPreview,
  SnapshotEntry,
  SnapshotText,
  TrashEntry,
  TreeItem,
  VaultPreflight,
  VaultTagEntry,
} from "./types"

const WEB_VAULT = "web-vault"
const TREE_KEY = "amby:tree"
const FILE_PREFIX = "amby:file:"
const GLOBAL_WEB_PREFIX = "amby:g:"
const VAULT_WEB_PREFIX = "amby:vmeta:"
const CREDENTIAL_WEB_PREFIX = "amby:cred:"

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
    return stored ? (JSON.parse(stored) as TreeItem[]) : webDefaultTree()
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

function flattenWebNotes(items: TreeItem[]): TreeItem[] {
  const notes: TreeItem[] = []
  for (const item of items) {
    if (item.type === "file") notes.push(item)
    if (item.children) notes.push(...flattenWebNotes(item.children))
  }
  return notes
}

export class WebAdapter implements StoragePort {
  async openVault(): Promise<string | null> {
    return WEB_VAULT
  }

  async startVaultWatcher(_vaultPath: string): Promise<void> {}

  async stopVaultWatcher(): Promise<void> {}

  async loadVaultData(_vaultPath: string): Promise<LoadVaultResult> {
    const tree = webGetTree()
    const notes = flattenWebNotes(tree).map((item) => ({
      id: item.id,
      path: item.path ?? item.id,
      title: item.name,
      wordCount: (localStorage.getItem(FILE_PREFIX + item.id) ?? "").split(/\s+/).filter(Boolean)
        .length,
    }))
    return {
      generation: 0,
      tree,
      notes,
      sync: { inserted: 0, updated: 0, deleted: 0, warnings: [], pathToId: {} },
    }
  }

  async loadActiveVaultData(): Promise<LoadVaultResult> {
    return this.loadVaultData(WEB_VAULT)
  }

  async preflightVault(_vaultPath: string): Promise<VaultPreflight> {
    return {
      notes: 0,
      attachments: 0,
      malformedFrontmatter: [],
      userManagedIds: [],
      duplicateIds: [],
      plannedIdWrites: [],
      unfinishedMigrations: [],
    }
  }

  async applyIdMigration(_vaultPath: string): Promise<void> {}

  async inspectIdMigrations(_vaultPath: string): Promise<IdMigrationRecovery[]> {
    return []
  }

  async recoverIdMigration(
    _vaultPath: string,
    _journalPath: string,
    _action: IdMigrationRecoveryAction,
  ): Promise<IdMigrationRecovery> {
    throw new Error(i18n.t("errors.localHistoryDesktopOnly"))
  }

  async listFiles(_vaultPath: string): Promise<TreeItem[]> {
    return webGetTree()
  }

  async readFile(path: string): Promise<string> {
    return localStorage.getItem(FILE_PREFIX + path) ?? webDefaultContent(path)
  }

  async readNote(_vaultPath: string, noteId: string): Promise<string> {
    const content = await this.readFile(noteId)
    return splitWebFrontmatter(content)?.body ?? content
  }

  async writeFile(path: string, content: string): Promise<void> {
    localStorage.setItem(FILE_PREFIX + path, content)
  }

  async writeNote(
    _vaultPath: string,
    noteId: string,
    content: string,
    _expectedGeneration: number | null,
  ): Promise<void> {
    const current = await this.readFile(noteId)
    const frontmatter = splitWebFrontmatter(current)
    await this.writeFile(noteId, `${frontmatter?.envelope ?? ""}${content}`)
  }

  async saveConflictCopy(path: string, content: string): Promise<string> {
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

  async createNote(
    _vaultPath: string,
    parentPath: string,
    name: string,
  ): Promise<FsMutationResult> {
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

  async createFolder(vaultPath: string, name: string): Promise<string> {
    const path = joinPath(vaultPath, name)
    const tree = webGetTree()
    const parent = webFindItem(tree, vaultPath)
    const folder: TreeItem = {
      id: path,
      path,
      name,
      type: "folder",
      icon: "folder",
      children: [],
    }
    webSaveTree(webAddChild(tree, parent?.type === "folder" ? vaultPath : null, folder))
    return path
  }

  async createCanvasFile(
    _vaultPath: string,
    parentPath: string | null,
    name: string,
  ): Promise<string> {
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

  async attachCanvasToNote(_vaultPath: string, canvasPath: string): Promise<FsMutationResult> {
    const dir = pathDir(canvasPath)
    const stem = pathStem(canvasPath)
    const content = localStorage.getItem(FILE_PREFIX + canvasPath) ?? "{}\n"

    let name = stem
    let i = 2
    while (webFindItem(webGetTree(), joinPath(dir, `${name}.md`))) {
      name = `${stem}-${i}`
      i += 1
    }
    const createRes = await this.createNote(dir, dir, name)
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

  async renameItem(_vaultPath: string, path: string, newName: string): Promise<FsMutationResult> {
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

  async moveItem(
    vaultPath: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<FsMutationResult> {
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

  async deleteItem(_vaultPath: string, path: string): Promise<FsMutationResult> {
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

  async noteLayers(notePath: string): Promise<NoteLayers> {
    const stem = pathStem(notePath)
    const dir = pathDir(notePath)
    if (pathBase(dir) !== stem) return { canvas: false, sketch: false, database: false }
    return {
      canvas: localStorage.getItem(FILE_PREFIX + joinPath(dir, `${stem}.canvas`)) !== null,
      sketch: localStorage.getItem(FILE_PREFIX + joinPath(dir, `${stem}.excalidraw`)) !== null,
      database: localStorage.getItem(FILE_PREFIX + joinPath(dir, "Metadata.md")) !== null,
    }
  }

  async createLayer(notePath: string, kind: LayerKind): Promise<LayerResult> {
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

  async unlinkLayer(
    _vaultPath: string,
    notePath: string,
    kind: LayerKind,
  ): Promise<FsMutationResult> {
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

  async deleteLayer(
    _vaultPath: string,
    notePath: string,
    kind: LayerKind,
  ): Promise<FsMutationResult> {
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

  async getNoteMetadata(_vaultPath: string, noteId: string): Promise<FileMetadata> {
    const content = localStorage.getItem(FILE_PREFIX + noteId) ?? ""
    return { word_count: content.split(/\s+/).filter(Boolean).length }
  }

  async getFileMetadata(path: string): Promise<FileMetadata> {
    const content = localStorage.getItem(FILE_PREFIX + path) ?? ""
    return { word_count: content.split(/\s+/).filter(Boolean).length }
  }

  async getNoteProperties(_vaultPath: string, noteId: string): Promise<NoteProperties> {
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

  async upsertCustomProperty(
    _vaultPath: string,
    noteId: string,
    property: CustomProperty,
  ): Promise<CustomProperty> {
    const current = (await this.getNoteProperties("", noteId)).customProperties
    const saved = { ...property, id: property.id || crypto.randomUUID() }
    const index = current.findIndex((item) => item.id === saved.id)
    if (index >= 0) current[index] = saved
    else current.push(saved)
    localStorage.setItem(`amby:custom-properties:${noteId}`, JSON.stringify(current))
    return saved
  }

  async deleteCustomProperty(
    _vaultPath: string,
    noteId: string,
    propertyId: string,
  ): Promise<void> {
    const current = (await this.getNoteProperties("", noteId)).customProperties.filter(
      (property) => property.id !== propertyId,
    )
    localStorage.setItem(`amby:custom-properties:${noteId}`, JSON.stringify(current))
  }

  async getLinkGraph(_vaultPath: string): Promise<LinkGraph> {
    return { nodes: [], edges: [] }
  }

  async listTags(_vaultPath: string): Promise<VaultTagEntry[]> {
    return []
  }

  async listSnapshots(_sourcePath: string): Promise<SnapshotEntry[]> {
    return []
  }

  async restoreSnapshot(_snapshotId: string): Promise<string> {
    throw new Error(i18n.t("errors.localHistoryDesktopOnly"))
  }

  async readSnapshotText(_snapshotId: string): Promise<SnapshotText> {
    throw new Error(i18n.t("errors.localHistoryDesktopOnly"))
  }

  async listTrash(): Promise<TrashEntry[]> {
    return []
  }

  async restoreTrash(_trashId: string): Promise<FsMutationResult> {
    throw new Error(i18n.t("errors.trashDesktopOnly"))
  }

  async previewRenameRefactor(
    _vaultPath: string,
    _path: string,
    _newName: string,
  ): Promise<RefactorPreview> {
    return { notes: 0, replacements: 0 }
  }

  async previewMoveRefactor(
    _vaultPath: string,
    _sourcePath: string,
    _targetPath: string,
  ): Promise<RefactorPreview> {
    return { notes: 0, replacements: 0 }
  }

  async openInExplorer(_path: string): Promise<void> {}

  async pickAssetFile(_imagesOnly: boolean): Promise<string | null> {
    return null
  }

  async importAsset(
    _vaultPath: string,
    _notePath: string,
    _sourcePath: string,
  ): Promise<ImportedAsset | null> {
    return null
  }

  async importAssetBytes(
    _vaultPath: string,
    _notePath: string,
    _bytes: Uint8Array,
    _suggestedExt: string,
  ): Promise<ImportedAsset | null> {
    return null
  }

  async toAssetUrl(absPath: string): Promise<string> {
    return absPath
  }

  async exportTextFile(contents: string, defaultName: string): Promise<string | null> {
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

  async importTextFile(): Promise<string | null> {
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

  async confirmAction(message: string): Promise<boolean> {
    return typeof window !== "undefined" ? window.confirm(message) : false
  }

  async showErrorMessage(message: string): Promise<void> {
    if (typeof window !== "undefined") window.alert(message)
  }

  async readGlobalRaw(file: string): Promise<string | null> {
    return localStorage.getItem(GLOBAL_WEB_PREFIX + file)
  }

  async writeGlobalRaw(file: string, contents: string): Promise<void> {
    localStorage.setItem(GLOBAL_WEB_PREFIX + file, contents)
  }

  async readVaultRaw(rel: string): Promise<string | null> {
    return localStorage.getItem(VAULT_WEB_PREFIX + rel)
  }

  async writeVaultRaw(rel: string, contents: string): Promise<void> {
    localStorage.setItem(VAULT_WEB_PREFIX + rel, contents)
  }

  async deleteVaultMeta(rel: string): Promise<void> {
    localStorage.removeItem(VAULT_WEB_PREFIX + rel)
  }

  async storeAiCredential(credentialId: string, secret: string): Promise<void> {
    localStorage.setItem(CREDENTIAL_WEB_PREFIX + credentialId, secret)
  }

  async deleteAiCredential(credentialId: string): Promise<void> {
    localStorage.removeItem(CREDENTIAL_WEB_PREFIX + credentialId)
  }

  async inspectAiCredential(credentialId: string): Promise<CredentialInfo> {
    const secret = localStorage.getItem(CREDENTIAL_WEB_PREFIX + credentialId)
    if (secret === null) {
      return { exists: false, masked: null }
    }
    const trimmed = secret.trim()
    if (trimmed.length === 0) {
      return { exists: true, masked: "" }
    }
    if (trimmed.length <= 8) {
      return { exists: true, masked: "••••••••" }
    }
    const prefix = trimmed.slice(0, 3)
    const suffix = trimmed.slice(-4)
    return { exists: true, masked: `${prefix}••••${suffix}` }
  }
}
