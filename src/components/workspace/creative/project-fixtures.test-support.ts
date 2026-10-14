import type {
  ProjectCatalog,
  StorySummary,
  WorkshopSectionSummary,
  WorkshopSummary,
} from "@/lib/storage"

export function workshopSection(
  id: string,
  overrides: Partial<WorkshopSectionSummary> = {},
): WorkshopSectionSummary {
  return {
    id,
    role: "custom",
    name: overrides.name ?? overrides.databaseName ?? id,
    databaseId: `db_${id}`,
    pathHint: id,
    storiesPropertyId: null,
    universePropertyId: null,
    state: "ok",
    resolvedPath: id,
    databaseName: id,
    ...overrides,
  }
}

export const section = workshopSection

export function storySummary(storyId: string, overrides: Partial<StorySummary> = {}): StorySummary {
  return {
    storyId,
    workshopId: "w1",
    name: storyId,
    folderPath: `stories/${storyId}`,
    cardPath: `stories/${storyId}/${storyId}.md`,
    cardNoteId: `note_${storyId}`,
    databaseId: `db_${storyId}`,
    fileRevision: "r".repeat(64),
    formatVersion: 3,
    textJson: "{}",
    text: null,
    ...overrides,
  }
}

export function workshopSummary(
  workshopId: string,
  overrides: Partial<WorkshopSummary> = {},
): WorkshopSummary {
  return {
    workshopId,
    name: workshopId,
    icon: null,
    tags: [],
    path: workshopId,
    fileRevision: "r".repeat(64),
    formatVersion: 3,
    readOnly: false,
    sections: [],
    stories: [],
    ...overrides,
  }
}

export function project(id: string, overrides: Partial<WorkshopSummary> = {}): WorkshopSummary {
  return workshopSummary(id, overrides)
}

export function catalog(
  workshops: WorkshopSummary[],
  overrides: Partial<ProjectCatalog> = {},
): ProjectCatalog {
  return { vaultGeneration: 1, indexEpoch: "e1", workshops, diagnostics: [], ...overrides }
}

/** A workshop with sections and stories, as the sidebar and the page see it. */
export function universeCatalog(): ProjectCatalog {
  const workshop = workshopSummary("palooverse", {
    name: "Palooverse",
    sections: [
      workshopSection("stories", { role: "stories", name: "Истории", databaseId: "db_stories" }),
      workshopSection("characters", {
        role: "characters",
        name: "Персонажи",
        databaseId: "db_characters",
      }),
      workshopSection("locations", {
        role: "locations",
        name: "Локации",
        databaseId: "db_locations",
      }),
      workshopSection("notes", { role: "notes", name: "Заметки", databaseId: "db_notes" }),
      workshopSection("anchors", { role: "anchors", name: "Якоря", databaseId: "db_anchors" }),
      workshopSection("loose", { role: "custom", name: "Прочее", databaseId: "db_loose" }),
    ],
    stories: [
      storySummary("molehills", {
        workshopId: "palooverse",
        name: "MoleHills",
        databaseId: "db_molehills_text",
      }),
      storySummary("tale", {
        workshopId: "palooverse",
        name: "Рассказ",
        databaseId: "db_tale_text",
      }),
    ],
  })
  return catalog([workshop])
}
