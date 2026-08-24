import type { FrontmatterProperty, NoteProperties } from "./types"

export function splitWebFrontmatter(
  content: string,
): { envelope: string; yaml: string; body: string } | null {
  const match = /^(---\n)([\s\S]*?)(\n---\n?)/u.exec(content)
  if (!match) return null
  return { envelope: match[0], yaml: match[2], body: content.slice(match[0].length) }
}

/** Deterministic same-process CAS revision for the browser fallback. */
export function webRevision(body: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function webNoteProperties(content: string): NoteProperties {
  const frontmatter = splitWebFrontmatter(content)
  if (!frontmatter) return { hasFrontmatter: false, properties: [], customProperties: [] }
  const properties: FrontmatterProperty[] = []
  for (const line of frontmatter.yaml.split("\n")) {
    if (!line || /^\s/u.test(line) || line.trimStart().startsWith("#")) continue
    const separator = line.indexOf(":")
    if (separator < 1) continue
    properties.push({
      key: line.slice(0, separator).trim(),
      value: line
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/gu, ""),
      valueKind: "text",
    })
  }
  return { hasFrontmatter: true, properties, customProperties: [] }
}
