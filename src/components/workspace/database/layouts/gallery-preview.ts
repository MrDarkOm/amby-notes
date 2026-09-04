const UNSAFE_PATH_SEGMENTS = new Set(["", ".", ".."])

export type GalleryPreview =
  | { kind: "asset"; relativePath: string }
  | { kind: "placeholder"; reason: "missing" | "invalid" | "unsupported" }

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return false
  }
  return !value.split(/[\\/]/).some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))
}

/** Chooses a local, bundle-relative preview without resolving external URLs. */
export function resolveGalleryPreview(valuesJson: string): GalleryPreview {
  let values: unknown
  try {
    values = JSON.parse(valuesJson)
  } catch {
    return { kind: "placeholder", reason: "invalid" }
  }
  if (!values || typeof values !== "object") return { kind: "placeholder", reason: "missing" }
  for (const value of Object.values(values as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "files")
      continue
    const items = (value as { items?: unknown }).items
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (!item || typeof item !== "object") continue
      const candidate = (item as { relativePath?: unknown }).relativePath
      if (isSafeRelativePath(candidate)) return { kind: "asset", relativePath: candidate }
    }
  }
  return { kind: "placeholder", reason: "unsupported" }
}
