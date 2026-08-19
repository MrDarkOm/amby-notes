export function workspaceRelativePath(path: string, workspacePath: string): string {
  const normalizedPath = path.replace(/\\/g, "/")
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/u, "")
  const prefix = `${normalizedWorkspace}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath
}

export { EmptyStateHeader } from "./empty-state-header"
