import type { ProjectCatalog, ProjectSectionSummary, ProjectSummary } from "@/lib/storage"

export function section(
  id: string,
  overrides: Partial<ProjectSectionSummary> = {},
): ProjectSectionSummary {
  return {
    id,
    role: null,
    groupId: null,
    databaseId: `db_${id}`,
    pathHint: id,
    state: "ok",
    resolvedPath: id,
    databaseName: id,
    ...overrides,
  }
}

export function project(
  projectId: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    projectId,
    kind: "story",
    name: projectId,
    icon: null,
    tags: [],
    path: projectId,
    fileRevision: "r".repeat(64),
    formatVersion: 2,
    readOnly: false,
    collectionId: null,
    groups: [],
    sections: [],
    textJson: null,
    text: null,
    ...overrides,
  }
}

export function catalog(
  projects: ProjectSummary[],
  overrides: Partial<ProjectCatalog> = {},
): ProjectCatalog {
  return { vaultGeneration: 1, indexEpoch: "e1", projects, diagnostics: [], ...overrides }
}

/** A universe with one story, as the sidebar and the page see it. */
export function universeCatalog(): ProjectCatalog {
  const universe = project("palooverse", {
    kind: "collection",
    name: "Palooverse",
    groups: [{ id: "world", name: "Мир" }],
    sections: [
      section("characters", { role: "characters", groupId: "world", databaseName: "Персонажи" }),
      section("locations", { role: "locations", groupId: "world", databaseName: "Локации" }),
    ],
  })
  const story = project("molehills", {
    name: "MoleHills",
    path: "palooverse/molehills",
    collectionId: "palooverse",
    groups: [
      { id: "work", name: "Произведение" },
      { id: "world", name: "Мир" },
    ],
    sections: [
      section("notes", { role: "notes", groupId: "work", databaseName: "Заметки" }),
      section("text", { role: "text", groupId: "work", databaseName: "Текст" }),
      section("places", { role: "locations", groupId: "world", databaseName: "Локации" }),
      section("loose", { databaseName: "Прочее" }),
    ],
  })
  const alone = project("tale", { name: "Рассказ" })
  return catalog([universe, story, alone])
}
