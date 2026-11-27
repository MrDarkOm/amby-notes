export interface SnapshotAssets {
  vaultPath: string
  notePath: string
}

/** Resolve from the previewed note, never from whichever editor is active. */
export function snapshotImagePaths(src: string, context?: SnapshotAssets): string[] {
  if (/^https?:\/\//iu.test(src) || /^data:image\/(png|jpeg|gif|webp);base64,/iu.test(src))
    return [src]
  if (!context || /^(?:[a-z]+:|\/|\\)/iu.test(src)) return []
  let decoded: string
  try {
    decoded = decodeURIComponent(src)
  } catch {
    return []
  }
  const vault = context.vaultPath.replace(/\\/gu, "/").replace(/\/$/u, "")
  const note = context.notePath.replace(/\\/gu, "/")
  const dir = note.slice(0, note.lastIndexOf("/"))
  const paths = [`${dir}/${decoded}`]
  if (!decoded.includes("/")) paths.push(`${dir}/assets/${decoded}`, `${vault}/assets/${decoded}`)
  if (decoded.startsWith("assets/")) paths.push(`${vault}/${decoded}`)
  return [
    ...new Set(
      paths.flatMap((path) => {
        const parts: string[] = []
        for (const part of path.split("/")) {
          if (part === "..") parts.pop()
          else if (part && part !== ".") parts.push(part)
        }
        const normalized = `${vault.startsWith("/") ? "/" : ""}${parts.join("/")}`
        return normalized.startsWith(`${vault}/`) ? [normalized] : []
      }),
    ),
  ]
}
