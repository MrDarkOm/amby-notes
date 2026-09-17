import type { FrontmatterProperty, NoteProperties } from "./types"

export function splitWebFrontmatter(
  content: string,
): { envelope: string; yaml: string; body: string } | null {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/u.exec(content)
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
  const lines = frontmatter.yaml.split("\n")
  let currentProp: FrontmatterProperty | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line || line.trimStart().startsWith("#")) continue

    const listMatch = /^\s+-\s+(.+)$/u.exec(line)
    if (listMatch && currentProp) {
      currentProp.valueKind = "list"
      const item = listMatch[1].trim().replace(/^['"]|['"]$/gu, "")
      currentProp.value = currentProp.value ? `${currentProp.value}\n- ${item}` : `- ${item}`
      continue
    }

    if (/^\s/u.test(line)) continue
    const separator = line.indexOf(":")
    if (separator < 1) continue

    const key = line.slice(0, separator).trim()
    const rawVal = line.slice(separator + 1).trim()
    const cleanVal = rawVal.replace(/^['"]|['"]$/gu, "")

    let valueKind = "text"
    if (cleanVal === "true" || cleanVal === "false") {
      valueKind = "checkbox"
    } else if (cleanVal !== "" && !Number.isNaN(Number(cleanVal))) {
      valueKind = "number"
    } else if (cleanVal.startsWith("[") && cleanVal.endsWith("]")) {
      valueKind = "list"
    }

    currentProp = {
      key,
      value: cleanVal,
      valueKind,
    }
    properties.push(currentProp)
  }
  return { hasFrontmatter: true, properties, customProperties: [] }
}

export function upsertWebFrontmatterProperty(
  content: string,
  noteId: string,
  key: string,
  value: string,
  propertyType?: string,
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const cleanKey = key.trim()
  if (!cleanKey) return content

  let formattedValue = value.trim()
  if (propertyType === "checkbox") {
    formattedValue =
      formattedValue.toLowerCase() === "true" || formattedValue === "1" ? "true" : "false"
  } else if (propertyType === "list") {
    if (!formattedValue.startsWith("[") && !formattedValue.startsWith("-")) {
      const items = formattedValue
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      formattedValue = `[${items.join(", ")}]`
    }
  }

  const frontmatter = splitWebFrontmatter(content)
  if (!frontmatter) {
    return `---${eol}amby-id: ${noteId}${eol}${cleanKey}: ${formattedValue}${eol}---${eol}${content}`
  }

  const lines = frontmatter.yaml.split(eol)
  let found = false
  const updatedLines: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    if (!trimmed.startsWith("#") && trimmed.startsWith(`${cleanKey}:`)) {
      found = true
      updatedLines.push(`${cleanKey}: ${formattedValue}`)
      while (i + 1 < lines.length && /^\s+-\s+/u.test(lines[i + 1])) {
        i++
      }
    } else {
      updatedLines.push(line)
    }
  }

  if (!found) {
    updatedLines.push(`${cleanKey}: ${formattedValue}`)
  }

  const newYaml = updatedLines.join(eol)
  return `---${eol}${newYaml}${eol}---${eol}${frontmatter.body}`
}

export function removeWebFrontmatterProperty(content: string, key: string): string {
  const frontmatter = splitWebFrontmatter(content)
  if (!frontmatter) return content
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const cleanKey = key.trim()
  if (!cleanKey) return content

  const lines = frontmatter.yaml.split(eol)
  const updatedLines: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    if (!trimmed.startsWith("#") && trimmed.startsWith(`${cleanKey}:`)) {
      while (i + 1 < lines.length && /^\s+-\s+/u.test(lines[i + 1])) {
        i++
      }
    } else {
      updatedLines.push(line)
    }
  }

  const newYaml = updatedLines.join(eol)
  return `---${eol}${newYaml}${eol}---${eol}${frontmatter.body}`
}
