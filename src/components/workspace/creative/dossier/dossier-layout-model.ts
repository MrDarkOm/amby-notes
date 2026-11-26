import type { DossierLayout, DossierSection } from "@/lib/storage"

/**
 * The dossier layout of a section's template (pure; format §14): the sections (tabs) of a
 * dossier, a hint for each and the properties shown in it. Every edit returns a new layout; the
 * template editor keeps one as its draft and saves it whole.
 */

const LAYOUT_VERSION = 1
const HEADING = /^##\s+(.+?)\s*$/u

function nextId(sections: readonly DossierSection[]): string {
  const taken = new Set(sections.map((section) => section.id))
  let index = sections.length + 1
  while (taken.has(`section-${index}`)) index += 1
  return `section-${index}`
}

/**
 * The layout of a template that has none yet: its `## ` headings in order, each with the hint
 * known for that heading (the built-in presets' hints), and no fields. A body without headings
 * gives one section named `fallbackTitle`.
 */
export function layoutFromBody(
  body: string,
  knownHints: ReadonlyMap<string, string>,
  fallbackTitle = "",
): DossierLayout {
  const sections: DossierSection[] = []
  const seen = new Set<string>()
  for (const line of body.split(/\r?\n/u)) {
    const title = HEADING.exec(line)?.[1]?.trim()
    if (!title || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    sections.push({
      id: `section-${sections.length + 1}`,
      title,
      hint: knownHints.get(title) ?? "",
      fields: [],
    })
  }
  if (sections.length === 0) {
    sections.push({ id: "section-1", title: fallbackTitle, hint: "", fields: [] })
  }
  return { version: LAYOUT_VERSION, sections }
}

export function addSection(layout: DossierLayout, title: string): DossierLayout {
  return {
    ...layout,
    sections: [...layout.sections, { id: nextId(layout.sections), title, hint: "", fields: [] }],
  }
}

/** The layout with a section one place up or down; the same object at the edge. */
export function moveSection(layout: DossierLayout, index: number, by: -1 | 1): DossierLayout {
  const target = index + by
  if (index < 0 || index >= layout.sections.length || target < 0) return layout
  if (target >= layout.sections.length) return layout
  const sections = [...layout.sections]
  const [moved] = sections.splice(index, 1)
  sections.splice(target, 0, moved)
  return { ...layout, sections }
}

export function updateSection(
  layout: DossierLayout,
  id: string,
  patch: Partial<Pick<DossierSection, "title" | "hint">>,
): DossierLayout {
  return {
    ...layout,
    sections: layout.sections.map((section) =>
      section.id === id ? { ...section, ...patch } : section,
    ),
  }
}

export function removeSection(layout: DossierLayout, id: string): DossierLayout {
  return { ...layout, sections: layout.sections.filter((section) => section.id !== id) }
}

/** Puts a field at the end of a section; a field stands in one section only. */
export function addField(layout: DossierLayout, id: string, field: string): DossierLayout {
  return {
    ...layout,
    sections: layout.sections.map((section) => {
      const rest = (section.fields ?? []).filter((candidate) => candidate !== field)
      return section.id === id
        ? { ...section, fields: [...rest, field] }
        : { ...section, fields: rest }
    }),
  }
}

export function removeField(layout: DossierLayout, id: string, field: string): DossierLayout {
  return {
    ...layout,
    sections: layout.sections.map((section) =>
      section.id === id
        ? { ...section, fields: (section.fields ?? []).filter((candidate) => candidate !== field) }
        : section,
    ),
  }
}

/** The hint under each heading, for the editor's empty sections (only sections with a hint). */
export function layoutHints(layout: DossierLayout): Map<string, string> {
  return new Map(
    layout.sections
      .filter((section) => (section.hint ?? "").trim() !== "")
      .map((section) => [section.title.trim(), (section.hint ?? "").trim()]),
  )
}

/** The section a heading of a page is, by title, ignoring case and spaces around it. */
export function sectionOfTitle(layout: DossierLayout, title: string): DossierSection | null {
  const wanted = title.trim().toLowerCase()
  return layout.sections.find((section) => section.title.trim().toLowerCase() === wanted) ?? null
}

/** The fields the header keeps: those no section of the layout shows. */
export function fieldsOutsideSections(
  layout: DossierLayout | null,
  fields: readonly string[],
): string[] {
  if (!layout) return [...fields]
  const placed = new Set(layout.sections.flatMap((section) => section.fields ?? []))
  return fields.filter((field) => !placed.has(field))
}

/** What the backend would refuse in a layout, checked before saving it. */
export function layoutProblem(layout: DossierLayout): "empty" | "title" | "duplicate" | null {
  if (layout.sections.length === 0) return "empty"
  const titles = new Set<string>()
  for (const section of layout.sections) {
    const title = section.title.trim()
    if (!title || /[\r\n]/u.test(title) || title.startsWith("#")) return "title"
    const key = title.toLowerCase()
    if (titles.has(key)) return "duplicate"
    titles.add(key)
  }
  return null
}
