import type { Node } from "@tiptap/pm/model"

/** Dossiers use the shallowest top-level heading for their sections and start at H2. */
export function missingHeadingNodes(doc: Node, titles: readonly string[]): Node[] {
  const existing: { level: number; title: string }[] = []
  let shallowest = Infinity
  doc.forEach((node) => {
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level)
      shallowest = Math.min(shallowest, level)
      existing.push({ level, title: node.textContent })
    }
  })
  const level = existing.length > 0 ? shallowest : 2
  const seen = new Set(
    existing
      .filter((heading) => heading.level === level)
      .map((heading) => heading.title.trim().toLowerCase()),
  )
  const { schema } = doc.type
  const missing: Node[] = []
  for (const title of titles) {
    const name = title.trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    missing.push(schema.nodes.heading.create({ level }, schema.text(name)))
  }
  return missing
}
