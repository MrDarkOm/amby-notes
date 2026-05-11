import type { TreeItem } from "@/components/workspace/sidebar-tree"

export interface FileMetadata {
  created?: number
  modified?: number
  word_count: number
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
      name: "Welcome",
      type: "file" as const,
      icon: "brain" as const,
    },
    {
      id: "web-vault/Notes.md",
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

// ── Public API ───────────────────────────────────────────────────────────────

export async function openVault(): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("open_vault")
  return WEB_VAULT
}

export async function listFiles(vaultPath: string): Promise<TreeItem[]> {
  if (isTauri()) return invoke<TreeItem[]>("list_files", { vaultPath })
  return webGetTree()
}

export async function readFile(path: string): Promise<string> {
  if (isTauri()) return invoke<string>("read_file", { path })
  return localStorage.getItem(FILE_PREFIX + path) ?? webDefaultContent(path)
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (isTauri()) return invoke<void>("write_file", { path, content })
  localStorage.setItem(FILE_PREFIX + path, content)
}

export async function createFile(vaultPath: string, name: string): Promise<string> {
  const path = `${vaultPath}/${name}.md`
  if (isTauri()) {
    await invoke<void>("create_file", { path })
  } else {
    localStorage.setItem(FILE_PREFIX + path, "")
    const tree = webGetTree()
    tree.push({ id: path, name, type: "file", icon: "file" })
    webSaveTree(tree)
  }
  return path
}

export async function createFolder(vaultPath: string, name: string): Promise<string> {
  const path = `${vaultPath}/${name}`
  if (isTauri()) {
    await invoke<void>("create_folder", { path })
  } else {
    const tree = webGetTree()
    tree.push({ id: path, name, type: "folder", icon: "folder", children: [] })
    webSaveTree(tree)
  }
  return path
}

export async function renameItem(oldPath: string, newPath: string): Promise<void> {
  if (isTauri()) return invoke<void>("rename_item", { oldPath, newPath })
  const content = localStorage.getItem(FILE_PREFIX + oldPath) ?? ""
  localStorage.setItem(FILE_PREFIX + newPath, content)
  localStorage.removeItem(FILE_PREFIX + oldPath)
}

export async function deleteItem(path: string): Promise<void> {
  if (isTauri()) return invoke<void>("delete_item", { path })
  localStorage.removeItem(FILE_PREFIX + path)
}

export async function getFileMetadata(path: string): Promise<FileMetadata> {
  if (isTauri()) return invoke<FileMetadata>("get_file_metadata", { path })
  const content = localStorage.getItem(FILE_PREFIX + path) ?? ""
  return { word_count: content.split(/\s+/).filter(Boolean).length }
}
