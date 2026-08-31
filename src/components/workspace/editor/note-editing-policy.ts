import type { NoteProperties } from "@/lib/storage"

export function noteEditingPolicy(properties?: NoteProperties) {
  // Older/browser payloads may not yet distinguish YAML errors from ID conflicts.
  const readOnly = properties?.bodyReadOnly ?? Boolean(properties?.parseError)
  const sourceOnly = properties?.frontmatterStatus === "unterminated"
  const warningKey = !properties?.parseError
    ? null
    : readOnly
      ? "workspace.identityReadOnly"
      : sourceOnly
        ? "workspace.unterminatedFrontmatter"
        : "workspace.invalidFrontmatter"
  return { readOnly, sourceOnly, warningKey }
}
