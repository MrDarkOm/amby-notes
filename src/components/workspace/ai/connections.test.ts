import { describe, expect, it } from "vitest"
import type { AiSettings } from "../app-config"
import {
  addLocalAiModel,
  canAddLocalAiModel,
  isFirstAiCatalog,
  moveAiModel,
  newChatModelId,
  projectAiConnections,
  setBaseAiModel,
  readLegacyAiConnections,
  readAiConnections,
  resolveConnectedAiModel,
  reconcileAiCatalog,
  selectableAiModels,
  setAiModelEnabled,
  setAiModelTools,
} from "./connections"

const legacy: AiSettings = {
  activeModelId: "old-2",
  models: [
    {
      id: "old-1",
      label: "One",
      provider: "openai",
      model: "a",
      baseUrl: "",
      credentialId: "key-1",
      apiVersion: "",
    },
    {
      id: "old-2",
      label: "Two",
      provider: "openai",
      model: "b",
      baseUrl: "",
      credentialId: "key-2",
      apiVersion: "",
    },
    {
      id: "local",
      label: "Local",
      provider: "ollama",
      model: "custom",
      baseUrl: "",
      apiVersion: "",
    },
  ],
}

describe("AI connection domain", () => {
  it("reads legacy models without merging keys or changing chat model IDs", () => {
    const result = readLegacyAiConnections(legacy)
    expect(result.connections.map((connection) => connection.credentialId)).toEqual([
      "key-1",
      "key-2",
      null,
    ])
    expect(result.models.map((model) => model.id)).toEqual(["old-1", "old-2", "local"])
    expect(result.activeModelId).toBe("old-2")
    expect(result.connections.map((connection) => connection.id)).toEqual([
      "legacy:old-1",
      "legacy:old-2",
      "legacy:local",
    ])
  })

  it("filters disabled models without mutating the original", () => {
    const result = readLegacyAiConnections(legacy)
    const changed = setAiModelEnabled(result, "old-2", false)
    expect(selectableAiModels(changed).map((model) => model.id)).toEqual(["old-1", "local"])
    expect(selectableAiModels(result)).toHaveLength(3)
  })

  it("allows manual models only for registered local providers", () => {
    const result = readLegacyAiConnections(legacy)
    expect(canAddLocalAiModel(result.connections[0])).toBe(false)
    expect(canAddLocalAiModel(result.connections[2])).toBe(true)
  })

  it("retains choices and history when a catalog changes", () => {
    const initial = readLegacyAiConnections(legacy)
    const updated = reconcileAiCatalog(initial, "legacy:old-1", [
      { model: "a", label: "Catalog A" },
      { model: "c", label: "Catalog C" },
    ])
    expect(updated.models.find((model) => model.id === "old-1")?.enabled).toBe(true)
    expect(updated.models.find((model) => model.model === "c")?.enabled).toBe(false)
    const missing = reconcileAiCatalog(updated, "legacy:old-1", [])
    expect(missing.models.find((model) => model.id === "old-1")).toMatchObject({
      available: false,
      enabled: true,
    })
    expect(selectableAiModels(missing).map((model) => model.id)).toEqual(["old-2", "local"])
  })
  it("enables the first models of a first catalog and leaves later ones off", () => {
    const initial = readLegacyAiConnections(legacy)
    const catalog = [
      { model: "n1", label: "N1" },
      { model: "n2", label: "N2" },
      { model: "n3", label: "N3" },
    ]
    expect(isFirstAiCatalog(initial, "legacy:old-1")).toBe(true)
    const first = reconcileAiCatalog(initial, "legacy:old-1", catalog, 2)
    expect(first.models.filter((m) => m.origin === "catalog").map((m) => m.enabled)).toEqual([
      true,
      true,
      false,
    ])
    expect(isFirstAiCatalog(first, "legacy:old-1")).toBe(false)
    const later = reconcileAiCatalog(first, "legacy:old-1", [
      ...catalog,
      { model: "n4", label: "N4" },
    ])
    expect(later.models.find((m) => m.model === "n4")?.enabled).toBe(false)
  })
  it("renames catalog models on refresh but keeps a legacy label", () => {
    const first = reconcileAiCatalog(
      readLegacyAiConnections(legacy),
      "legacy:old-1",
      [
        { model: "opus", label: "Opus" },
        { model: "a", label: "Catalog A" },
      ],
      2,
    )
    const next = reconcileAiCatalog(first, "legacy:old-1", [
      { model: "opus", label: "Opus 5.5" },
      { model: "a", label: "Catalog A" },
    ])
    expect(next.models.find((m) => m.model === "opus")?.label).toBe("Opus 5.5")
    expect(next.models.find((m) => m.id === "old-1")?.label).toBe("One")
  })
  it("moves a model only past neighbours of its own connection", () => {
    const base = readLegacyAiConnections(legacy)
    const a = reconcileAiCatalog(base, "legacy:old-1", [
      { model: "x", label: "X" },
      { model: "y", label: "Y" },
    ])
    const idOf = (s: typeof a, model: string) => s.models.find((m) => m.model === model)!.id
    const order = (s: typeof a) =>
      s.models.filter((m) => m.connectionId === "legacy:old-1").map((m) => m.model)
    const before = order(a)
    const up = moveAiModel(a, idOf(a, "y"), -1)
    expect(order(up).indexOf("y")).toBe(before.indexOf("y") - 1)
    expect(up.models.filter((m) => m.connectionId !== "legacy:old-1")).toEqual(
      a.models.filter((m) => m.connectionId !== "legacy:old-1"),
    )
    expect(moveAiModel(a, idOf(a, before[0]), -1)).toBe(a)
    expect(moveAiModel(a, "missing", 1)).toBe(a)
  })
  it("assigns separate stable internal IDs for the same catalog model across connections", () => {
    let result = readLegacyAiConnections(legacy)
    result = reconcileAiCatalog(result, "legacy:old-1", [{ model: "shared", label: "Shared" }])
    result = reconcileAiCatalog(result, "legacy:old-2", [{ model: "shared", label: "Shared" }])
    const ids = result.models.filter((model) => model.model === "shared").map((model) => model.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    const refreshed = reconcileAiCatalog(result, "legacy:old-1", [
      { model: "shared", label: "Shared" },
    ])
    expect(
      refreshed.models.filter((model) => model.model === "shared").map((model) => model.id),
    ).toEqual(ids)
  })
  it("validates the versioned shape and refuses disabled models on resolution", () => {
    const value = readLegacyAiConnections(legacy)
    expect(readAiConnections(value)).toBe(value)
    expect(() => readAiConnections({ ...value, version: 2 })).toThrow("unsupportedAiVersion")
    expect(() => readAiConnections({ ...value, connections: [] })).toThrow("invalidAiSettings")
    expect(resolveConnectedAiModel(value, "old-2")?.credentialId).toBe("key-2")
    expect(resolveConnectedAiModel(setAiModelEnabled(value, "old-2", false), "old-2")).toBeNull()
  })
  it("adds user models only to local providers", () => {
    const value = readLegacyAiConnections(legacy)
    expect(() => addLocalAiModel(value, "legacy:old-1", "custom", "Custom")).toThrow(
      "invalidAiModel",
    )
    const updated = addLocalAiModel(value, "legacy:local", "new", "New")
    expect(updated.models[updated.models.length - 1]).toMatchObject({
      model: "new",
      origin: "local",
      enabled: true,
    })
    expect(() => addLocalAiModel(updated, "legacy:local", "new", "New")).toThrow("duplicateAiModel")
  })
  it("lets the user say a model can call tools, and keeps it when the catalog is refreshed", () => {
    const first = reconcileAiCatalog(
      readLegacyAiConnections(legacy),
      "legacy:old-1",
      [{ model: "tooled", label: "Tooled" }],
      1,
    )
    const id = first.models.find((m) => m.model === "tooled")!.id
    expect(resolveConnectedAiModel(first, id)?.supportsTools).toBe(false)
    const on = setAiModelTools(first, id, true)
    expect(resolveConnectedAiModel(on, id)?.supportsTools).toBe(true)
    const refreshed = reconcileAiCatalog(on, "legacy:old-1", [{ model: "tooled", label: "Tooled" }])
    expect(resolveConnectedAiModel(refreshed, id)?.supportsTools).toBe(true)
  })
  it("keeps a base model for new chats and drops it when it is switched off", () => {
    const base = readLegacyAiConnections(legacy)
    expect(newChatModelId(projectAiConnections(base))).toBe("old-2")
    const withBase = setBaseAiModel(base, "old-1")
    expect(withBase.baseModelId).toBe("old-1")
    expect(newChatModelId(projectAiConnections(withBase))).toBe("old-1")
    expect(setBaseAiModel(withBase, "old-1").baseModelId).toBeNull()
    expect(setBaseAiModel(setAiModelEnabled(base, "old-1", false), "old-1").baseModelId).toBe(
      undefined,
    )
    const off = setAiModelEnabled(withBase, "old-1", false)
    expect(off.baseModelId).toBeNull()
    expect(newChatModelId(projectAiConnections(off))).toBe("old-2")
    expect(() => readAiConnections({ ...withBase, baseModelId: "nope" })).toThrow(
      "invalidAiSettings",
    )
    expect(readAiConnections({ ...withBase })).toEqual(withBase)
  })
  it("forgets a catalog model that left the catalog unless it was switched on", () => {
    const first = reconcileAiCatalog(
      readLegacyAiConnections(legacy),
      "legacy:old-1",
      [
        { model: "keep", label: "Keep" },
        { model: "gone-off", label: "Gone off" },
        { model: "gone-on", label: "Gone on" },
      ],
      0,
    )
    const withOn = setAiModelEnabled(
      first,
      first.models.find((m) => m.model === "gone-on")!.id,
      true,
    )
    const next = reconcileAiCatalog(withOn, "legacy:old-1", [{ model: "keep", label: "Keep" }])
    const names = next.models.filter((m) => m.connectionId === "legacy:old-1").map((m) => m.model)
    expect(names).toContain("keep")
    expect(names).toContain("gone-on")
    expect(names).not.toContain("gone-off")
    expect(next.models.find((m) => m.model === "gone-on")?.available).toBe(false)
  })
})
