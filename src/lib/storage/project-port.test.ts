import { afterEach, describe, expect, it, vi } from "vitest"

import { commands, type ProjectError } from "@/lib/bindings"
import { DesktopAdapter } from "./desktop-adapter"
import {
  addTextStatus,
  createStory,
  createWorkshop,
  createWorkshopSection,
  createTextPage,
  listNoteReferences,
  listProjects,
  listTextStats,
  moveTextPage,
  refreshProjects,
  removeWorkshopSection,
  reorderWorkshopSections,
  setStorageAdapter,
  updateWorkshop,
  updateTextLevels,
} from "./index"
import { unwrapProjectCommand } from "./project-port"
import { projectErrorMessage, ProjectOperationError } from "./project-types"
import { WebAdapter } from "./web-adapter"

const createdWorkshop = {
  operationId: "op-1",
  workshopId: "w1",
  name: "MoleHills",
  path: "MoleHills",
  filePath: "MoleHills/amby-workshop.json",
  fileRevision: "r".repeat(64),
  sections: [],
  replayed: false,
  warnings: [],
}

const createdStory = {
  operationId: "op-story-1",
  workshopId: "w1",
  storyId: "st1",
  title: "Глава 1",
  folderPath: "MoleHills/Истории/Глава 1",
  cardPath: "MoleHills/Истории/Глава 1/Глава 1.md",
  cardNoteId: "01NOTE",
  databaseId: "db1",
  storyFileRevision: "s".repeat(64),
  replayed: false,
  warnings: [],
}

const catalog = { vaultGeneration: 3, indexEpoch: "e1", workshops: [], diagnostics: [] }

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
      { kind: "workshopNotFound", workshopId: "w" },
      { kind: "storyNotFound", storyId: "s" },
      { kind: "workshopReadOnly", formatVersion: 3 },
      { kind: "storyReadOnly", formatVersion: 3 },
      { kind: "revisionConflict", actualRevision: "x" },
      { kind: "unsupportedRole", role: "galaxy" },
      { kind: "unsupportedPreset", preset: "galaxy" },
      { kind: "sectionNotFound", sectionId: "s" },
      { kind: "cannotRemoveStoriesSection" },
      { kind: "cannotRemoveTextSection" },
      { kind: "textNotConfigured" },
      { kind: "statusAlreadyConfigured" },
      { kind: "unknownTextLevel", levelId: "l" },
      { kind: "unknownTextFormat", formatId: "f" },
      { kind: "invalidOrderKey" },
      { kind: "pageNotFound", noteId: "n" },
      { kind: "parentCycle" },
      { kind: "parentLevelNotShallower", parentLevelId: "p", levelId: "l" },
      { kind: "levelInUse", levelId: "l", count: 2 },
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
    const createW = vi.spyOn(commands, "createWorkshop").mockResolvedValue({
      status: "ok",
      data: createdWorkshop,
    })
    const workshopReq = {
      expectedGeneration: 3,
      operationId: "op-1",
      name: "MoleHills",
    }
    await expect(createWorkshop(workshopReq)).resolves.toEqual(createdWorkshop)
    expect(createW).toHaveBeenCalledWith({
      ...workshopReq,
      parentPath: null,
      icon: null,
      tags: [],
      labels: {},
    })

    const createS = vi.spyOn(commands, "createStory").mockResolvedValue({
      status: "ok",
      data: createdStory,
    })
    const storyReq = {
      expectedGeneration: 3,
      operationId: "op-story-1",
      workshopId: "w1",
      title: "Глава 1",
      textLevels: ["Книга", "Сцена"],
    }
    await expect(createStory(storyReq)).resolves.toEqual(createdStory)
    expect(createS).toHaveBeenCalledWith({
      ...storyReq,
      labels: {},
    })

    const section = vi.spyOn(commands, "createWorkshopSection").mockResolvedValue({
      status: "error",
      error: { kind: "pathCollision", path: "MoleHills/Текст" },
    })
    await expect(
      createWorkshopSection({
        expectedGeneration: 3,
        operationId: "op-2",
        workshopId: "w1",
        expectedWorkshopRevision: "r".repeat(64),
        role: "custom",
        name: "Текст",
      }),
    ).rejects.toMatchObject({ kind: "pathCollision" })
    expect(section).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "custom",
        labels: {},
        name: "Текст",
      }),
    )

    const update = vi.spyOn(commands, "updateWorkshop").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-upd",
        workshopId: "w1",
        name: "Новое имя",
        icon: null,
        tags: [],
        workshopRevision: "r2",
        replayed: false,
        warnings: [],
      },
    })
    await updateWorkshop({
      expectedGeneration: 3,
      operationId: "op-upd",
      workshopId: "w1",
      expectedWorkshopRevision: "r1",
      name: "Новое имя",
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Новое имя", icon: null, tags: null }),
    )

    const removeSec = vi.spyOn(commands, "removeWorkshopSection").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-rm",
        workshopId: "w1",
        sectionId: "s1",
        workshopRevision: "r2",
        replayed: false,
        warnings: [],
      },
    })
    await removeWorkshopSection({
      expectedGeneration: 3,
      operationId: "op-rm",
      workshopId: "w1",
      expectedWorkshopRevision: "r1",
      sectionId: "s1",
    })
    expect(removeSec).toHaveBeenCalledWith(expect.objectContaining({ sectionId: "s1" }))

    const reorderSec = vi.spyOn(commands, "reorderWorkshopSections").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-ord",
        workshopId: "w1",
        sectionIds: ["s2", "s1"],
        workshopRevision: "r2",
        replayed: false,
        warnings: [],
      },
    })
    await reorderWorkshopSections({
      expectedGeneration: 3,
      operationId: "op-ord",
      workshopId: "w1",
      expectedWorkshopRevision: "r1",
      sectionIds: ["s2", "s1"],
    })
    expect(reorderSec).toHaveBeenCalledWith(expect.objectContaining({ sectionIds: ["s2", "s1"] }))

    const updLevels = vi.spyOn(commands, "updateTextLevels").mockResolvedValue({
      status: "ok",
      data: {
        operationId: "op-lvl",
        storyId: "st1",
        storyRevision: "r2",
        manifestRevision: "m2",
        levelIds: ["l1"],
        replayed: false,
        warnings: [],
      },
    })
    await updateTextLevels({
      expectedGeneration: 3,
      operationId: "op-lvl",
      storyId: "st1",
      expectedStoryRevision: "r1",
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
        storyId: "st1",
        propertyId: "prop-stat",
        storyRevision: "r2",
        manifestRevision: "m2",
        replayed: false,
        warnings: [],
      },
    })
    await addTextStatus({
      expectedGeneration: 3,
      operationId: "op-stat",
      storyId: "st1",
      expectedStoryRevision: "r1",
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
      storyId: "st1",
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
        operationId: "op_move",
        storyId: "st1",
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
    await expect(listProjects()).resolves.toMatchObject({ workshops: [], diagnostics: [] })
    await expect(refreshProjects(0)).resolves.toMatchObject({ workshops: [] })
    await expect(listTextStats("db_text")).resolves.toEqual([])
    await expect(
      createWorkshop({
        expectedGeneration: 0,
        operationId: "op",
        name: "x",
      }),
    ).rejects.toMatchObject({ name: "ProjectOperationError", kind: "failed" })
    await expect(
      createStory({
        expectedGeneration: 0,
        operationId: "op",
        workshopId: "w",
        title: "x",
      }),
    ).rejects.toMatchObject({ name: "ProjectOperationError", kind: "failed" })
    await expect(listNoteReferences("n")).resolves.toEqual([])
    await expect(
      createTextPage({
        expectedGeneration: 0,
        storyId: "s",
        title: "x",
        levelId: "l",
        orderKey: "a0",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      moveTextPage({
        expectedGeneration: 0,
        operationId: "op",
        storyId: "s",
        noteId: "n",
        orderKey: "a0",
        expectedRevision: "r",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      createWorkshopSection({
        expectedGeneration: 0,
        operationId: "op",
        workshopId: "w",
        expectedWorkshopRevision: "r",
        role: "custom",
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      updateWorkshop({
        expectedGeneration: 0,
        operationId: "op",
        workshopId: "w",
        expectedWorkshopRevision: "r",
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      removeWorkshopSection({
        expectedGeneration: 0,
        operationId: "op",
        workshopId: "w",
        expectedWorkshopRevision: "r",
        sectionId: "s",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      reorderWorkshopSections({
        expectedGeneration: 0,
        operationId: "op",
        workshopId: "w",
        expectedWorkshopRevision: "r",
        sectionIds: [],
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      updateTextLevels({
        expectedGeneration: 0,
        operationId: "op",
        storyId: "s",
        expectedStoryRevision: "r",
        levels: [{ name: "x" }],
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
    await expect(
      addTextStatus({
        expectedGeneration: 0,
        operationId: "op",
        storyId: "s",
        expectedStoryRevision: "r",
      }),
    ).rejects.toBeInstanceOf(ProjectOperationError)
  })
})
