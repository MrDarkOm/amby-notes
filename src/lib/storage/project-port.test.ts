import { afterEach, describe, expect, it, vi } from "vitest"

import { commands, type ProjectError } from "@/lib/bindings"
import { DesktopAdapter } from "./desktop-adapter"
import {
  addTextStatus,
  createProject,
  createProjectSection,
  createTextPage,
  listNoteReferences,
  listProjects,
  listTextStats,
  moveTextPage,
  refreshProjects,
  removeProjectSection,
  reorderProjectSections,
  setStorageAdapter,
  updateProject,
  updateTextLevels,
} from "./index"
import { unwrapProjectCommand } from "./project-port"
import { projectErrorMessage, ProjectOperationError } from "./project-types"
import { WebAdapter } from "./web-adapter"

const created = {
  operationId: "op-1",
  projectId: "p1",
  kind: "story" as const,
  name: "MoleHills",
  path: "MoleHills",
  filePath: "MoleHills/amby-project.json",
  fileRevision: "r".repeat(64),
  sections: [],
  replayed: false,
  warnings: [],
}

const catalog = { vaultGeneration: 3, indexEpoch: "e1", projects: [], diagnostics: [] }

afterEach(() => {
  setStorageAdapter(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("project port errors", () => {
  it("throws a typed error that keeps the Rust payload", () => {
    const error: ProjectError = { kind: "revisionConflict", actualRevision: "a".repeat(64) }
    try {
      unwrapProjectCommand({ status: "error", error })
      expect.unreachable()
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProjectOperationError)
      expect(caught).toMatchObject({ kind: "revisionConflict", error })
    }
    expect(unwrapProjectCommand({ status: "ok", data: 5 })).toBe(5)
  })

  it("has a message for every error kind", () => {
    const errors: ProjectError[] = [
      { kind: "moduleDisabled" },
      { kind: "vaultNotOpen" },
      { kind: "vaultGenerationConflict", actualGeneration: 2 },
      { kind: "invalidOperationId" },
      { kind: "operationIdReused", operationId: "op" },
      { kind: "invalidName", field: "name", reason: "empty" },
      { kind: "invalidParent", reason: "not a folder" },
      { kind: "pathCollision", path: "A" },
      { kind: "nestedCollectionUnsupported", ancestorPath: "U" },
      { kind: "parentProjectReadOnly", path: "F" },
      { kind: "projectNotFound", projectId: "p" },
      { kind: "projectReadOnly", formatVersion: 3 },
      { kind: "revisionConflict", actualRevision: "x" },
      { kind: "unknownGroup", groupId: "g" },
      { kind: "unsupportedRole", role: "galaxy" },
      { kind: "sectionNotFound", sectionId: "s" },
      { kind: "cannotRemoveTextSection" },
      { kind: "textNotConfigured" },
      { kind: "statusAlreadyConfigured" },
      { kind: "unknownTextLevel", levelId: "l" },
      { kind: "unknownTextFormat", formatId: "f" },
      { kind: "invalidOrderKey" },
      { kind: "pageNotFound", noteId: "n" },
      { kind: "parentCycle" },
      { kind: "parentLevelNotShallower", parentLevelId: "p", levelId: "l" },
      { kind: "unsupportedPreset", preset: "galaxy" },
      { kind: "rolledBack", operationId: "op", message: "boom" },
      { kind: "recoveryRequired", operationId: "op", message: "left" },
      { kind: "failed", code: "c", message: "plain" },
    ]
    for (const error of errors) expect(projectErrorMessage(error).length).toBeGreaterThan(0)
    expect(projectErrorMessage({ kind: "pathCollision", path: "A" })).toContain("A")
  })
})

describe("DesktopAdapter project delegation (mocked commands, not a live contract)", () => {
  it("passes requests through with explicit nulls and unwraps typed failures", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
    setStorageAdapter(new DesktopAdapter())
    const create = vi.spyOn(commands, "createProject").mockResolvedValue({
      status: "ok",
      data: created,
    })
    const request = {
      expectedGeneration: 3,
      operationId: "op-1",
      kind: "story" as const,
      name: "MoleHills",
      baseSections: true,
    }
    await expect(createProject(request)).resolves.toEqual(created)
    expect(create).toHaveBeenCalledWith({
      ...request,
      parentPath: null,
      icon: null,
      tags: [],
      labels: {},
    })

    // The levels the author chose travel with the request, untouched.
    await createProject({ ...request, operationId: "op-levels", textLevels: ["Книга", "Сцена"] })
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId: "op-levels", textLevels: ["Книга", "Сцена"] }),
    )

    const section = vi.spyOn(commands, "createProjectSection").mockResolvedValue({
      status: "error",
      error: { kind: "pathCollision", path: "MoleHills/Текст" },
    })
    await expect(
      createProjectSection({
        expectedGeneration: 3,
        operationId: "op-2",
        projectId: "p1",
        expectedProjectRevision: "r".repeat(64),
        name: "Текст",
      }),
    ).rejects.toMatchObject({ kind: "pathCollision" })
    expect(section).toHaveBeenCalledWith(
      expect.objectContaining({
        role: null,
        preset: null,
        groupId: null,
        labels: {},
        name: "Текст",
      }),
    )

    const update = vi.spyOn(commands, "updateProject").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-upd",
        projectId: "p1",
        name: "Новое имя",
        icon: null,
        tags: [],
        projectRevision: "r2",
        replayed: false,
        warnings: [],
      },
    })
    await updateProject({
      expectedGeneration: 3,
      operationId: "op-upd",
      projectId: "p1",
      expectedProjectRevision: "r1",
      name: "Новое имя",
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Новое имя", icon: null, tags: null }),
    )

    const removeSec = vi.spyOn(commands, "removeProjectSection").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-rm",
        projectId: "p1",
        sectionId: "s1",
        projectRevision: "r2",
        replayed: false,
        warnings: [],
      },
    })
    await removeProjectSection({
      expectedGeneration: 3,
      operationId: "op-rm",
      projectId: "p1",
      expectedProjectRevision: "r1",
      sectionId: "s1",
    })
    expect(removeSec).toHaveBeenCalledWith(expect.objectContaining({ sectionId: "s1" }))

    const reorderSec = vi.spyOn(commands, "reorderProjectSections").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-ord",
        projectId: "p1",
        sectionIds: ["s2", "s1"],
        projectRevision: "r2",
        replayed: false,
        warnings: [],
      },
    })
    await reorderProjectSections({
      expectedGeneration: 3,
      operationId: "op-ord",
      projectId: "p1",
      expectedProjectRevision: "r1",
      sectionIds: ["s2", "s1"],
    })
    expect(reorderSec).toHaveBeenCalledWith(expect.objectContaining({ sectionIds: ["s2", "s1"] }))

    const updLevels = vi.spyOn(commands, "updateTextLevels").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-lvl",
        projectId: "p1",
        projectRevision: "r2",
        manifestRevision: "m2",
        levelIds: ["l1"],
        replayed: false,
        warnings: [],
      },
    })
    await updateTextLevels({
      expectedGeneration: 3,
      operationId: "op-lvl",
      projectId: "p1",
      expectedProjectRevision: "r1",
      levels: [{ name: "Глава" }],
    })
    expect(updLevels).toHaveBeenCalledWith(
      expect.objectContaining({
        levels: [{ id: null, name: "Глава", icon: null }],
      }),
    )

    const addStat = vi.spyOn(commands, "addTextStatus").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-stat",
        projectId: "p1",
        propertyId: "prop-stat",
        projectRevision: "r2",
        manifestRevision: "m2",
        replayed: false,
        warnings: [],
      },
    })
    await addTextStatus({
      expectedGeneration: 3,
      operationId: "op-stat",
      projectId: "p1",
      expectedProjectRevision: "r1",
    })
    expect(addStat).toHaveBeenCalledWith(expect.objectContaining({ labels: {} }))

    const page = vi.spyOn(commands, "createTextPage").mockResolvedValue({
      status: "ok",
      data: {
        databaseId: "db",
        noteId: "n1",
        title: "Глава",
        notePath: "/v/Saga/Текст/Глава.md",
        levelId: "l",
        formatId: null,
        parentNoteId: null,
        orderKey: "a0",
        warnings: [],
      },
    })
    await createTextPage({
      expectedGeneration: 3,
      projectId: "p1",
      title: "Глава",
      levelId: "l",
      orderKey: "a0",
    })
    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({ parentNoteId: null, formatId: null, levelId: "l" }),
    )
    const move = vi
      .spyOn(commands, "moveTextPage")
      .mockResolvedValue({ status: "error", error: { kind: "parentCycle" } })
    await expect(
      moveTextPage({
        expectedGeneration: 3,
        operationId: "op-3",
        projectId: "p1",
        noteId: "n1",
        orderKey: "a1",
        expectedRevision: "r",
      }),
    ).rejects.toMatchObject({ kind: "parentCycle" })
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ newParentNoteId: null }))

    const references = vi
      .spyOn(commands, "listNoteReferences")
      .mockResolvedValue({ status: "ok", data: [] })
    await expect(listNoteReferences("01ABC")).resolves.toEqual([])
    expect(references).toHaveBeenCalledWith("01ABC")

    const stats = vi.spyOn(commands, "listTextStats").mockResolvedValue({
      status: "ok",
      data: [{ noteId: "n1", wordCount: 120, modified: 1_700_000_000, created: 1_699_999_000 }],
    })
    await expect(listTextStats("db_text")).resolves.toEqual([
      { noteId: "n1", wordCount: 120, modified: 1_700_000_000, created: 1_699_999_000 },
    ])
    expect(stats).toHaveBeenCalledWith("db_text")

    vi.spyOn(commands, "listProjects").mockResolvedValue({ status: "ok", data: catalog })
    const refresh = vi
      .spyOn(commands, "refreshProjects")
      .mockResolvedValue({ status: "ok", data: catalog })
    await expect(listProjects()).resolves.toEqual(catalog)
    await expect(refreshProjects(3)).resolves.toEqual(catalog)
    expect(refresh).toHaveBeenCalledWith(3)
  })
})

describe("WebAdapter projects", () => {
  it("lists nothing and refuses creation outside the desktop runtime", async () => {
    setStorageAdapter(new WebAdapter())
    await expect(listProjects()).resolves.toMatchObject({ projects: [], diagnostics: [] })
    await expect(refreshProjects(0)).resolves.toMatchObject({ projects: [] })
    await expect(listTextStats("db_text")).resolves.toEqual([])
    await expect(
      createProject({
        expectedGeneration: 0,
        operationId: "op",
        kind: "story",
        name: "x",
        baseSections: true,
      }),
    ).rejects.toMatchObject({ name: "ProjectOperationError", kind: "failed" })
    await expect(listNoteReferences("n")).resolves.toEqual([])
    await expect(
      createTextPage({
        expectedGeneration: 0,
        projectId: "p",
        title: "x",
        levelId: "l",
        orderKey: "a0",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      moveTextPage({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        noteId: "n",
        orderKey: "a0",
        expectedRevision: "r",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      createProjectSection({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        expectedProjectRevision: "r",
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      updateProject({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        expectedProjectRevision: "r",
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      removeProjectSection({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        expectedProjectRevision: "r",
        sectionId: "s",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      reorderProjectSections({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        expectedProjectRevision: "r",
        sectionIds: [],
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      updateTextLevels({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        expectedProjectRevision: "r",
        levels: [{ name: "x" }],
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      addTextStatus({
        expectedGeneration: 0,
        operationId: "op",
        projectId: "p",
        expectedProjectRevision: "r",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
  })
})
