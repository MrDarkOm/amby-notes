/** Preserve Windows verbatim paths: Win32 does not accept '/' after '\\?\'. */
export function joinStoragePath(parent: string, child: string): string {
  const separator = parent.includes("\\") ? "\\" : "/"
  return `${parent.replace(/[\\/]$/u, "")}${separator}${child.replace(/[\\/]/g, separator)}`
}
