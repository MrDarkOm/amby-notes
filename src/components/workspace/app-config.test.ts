import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadSettings,
  saveSettingsPatch,
  loadWorkspaceConfig,
  saveWorkspaceConfigPatch,
  loadSession,
  saveSession,
  loadWorkspaces,
  saveWorkspaces,
  SETTINGS_FILE,
  WORKSPACE_FILE,
  SESSION_FILE,
  SETTINGS_SCHEMA_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  WORKSPACES_SCHEMA_VERSION,
  SETTINGS_SAVE_ERROR_EVENT,
} from "./app-config"
import { readGlobalSettingsResult } from "@/lib/storage"

describe("app-config & settings storage resilience (WP-19)", () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    const target = new EventTarget()
    vi.stubGlobal("window", target)
    vi.stubGlobal(
      "CustomEvent",
      class CustomEvent<T> extends Event {
        detail: T
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type, init)
          this.detail = init?.detail as T
        }
      },
    )
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
      clear: () => store.clear(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("round-trips collapsed tree IDs without requiring an existing session migration", async () => {
    const session = await loadSession("/test/vault")
    expect(session.closedTreeIds ?? []).toEqual([])
    await saveSession({ ...session, closedTreeIds: ["folder:/test/vault/Projects", "note-id"] })
    expect((await loadSession("/test/vault")).closedTreeIds).toEqual([
      "folder:/test/vault/Projects",
      "note-id",
    ])
  })

  it("handles missing file by returning typed result and defaults with schemaVersion", async () => {
    const res = await readGlobalSettingsResult<unknown>("non-existent.json")
    expect(res.status).toBe("missing")

    const settings = await loadSettings()
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(settings.panelScope).toBe("global")
    expect(settings.prefs.theme).toBe("dark")

    const workspaces = await loadWorkspaces()
    expect(workspaces.schemaVersion).toBe(WORKSPACES_SCHEMA_VERSION)
    expect(workspaces.recent).toEqual([])

    const wsConfig = await loadWorkspaceConfig()
    expect(wsConfig.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION)
    expect(wsConfig.confirmations.confirmFileDelete).toBe(true)

    const session = await loadSession("/test/vault")
    expect(session.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
    expect(session.tabs).toEqual([])
  })

  it("handles corrupt JSON by creating a recoverable copy before restoring defaults", async () => {
    // Write corrupt json to global settings and vault session
    store.set("amby:g:" + SETTINGS_FILE, "{ corrupt: invalid json")
    store.set("amby:vmeta:" + SESSION_FILE, "not valid json {[[")

    const corruptRes = await readGlobalSettingsResult(SETTINGS_FILE)
    expect(corruptRes.status).toBe("corrupt")

    const settings = await loadSettings()
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(settings.prefs.theme).toBe("dark")

    // Check that corrupt backup was saved in storage
    const corruptKeys = [...store.keys()].filter((k) => k.includes("settings.json.corrupt-"))
    expect(corruptKeys.length).toBeGreaterThanOrEqual(1)
    expect(store.get(corruptKeys[0])).toBe("{ corrupt: invalid json")

    // Session corrupt handling
    const session = await loadSession("/test/vault")
    expect(session.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
    const sessionCorruptKeys = [...store.keys()].filter((k) => k.includes("session.json.corrupt-"))
    expect(sessionCorruptKeys.length).toBeGreaterThanOrEqual(1)
    expect(store.get(sessionCorruptKeys[0])).toBe("not valid json {[[")
  })

  it("propagates write failures and dispatches save error notification event", async () => {
    const errorListener = vi.fn()
    window.addEventListener(SETTINGS_SAVE_ERROR_EVENT, errorListener)

    // Simulate write failure by making localStorage throw
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("disk quota exceeded")
      },
      removeItem: () => {},
      clear: () => {},
    })

    await expect(saveSettingsPatch({ panelScope: "workspace" })).rejects.toMatchObject({
      code: "quotaExceeded",
    })
    expect(errorListener).toHaveBeenCalledTimes(1)

    await expect(saveWorkspaceConfigPatch({ theme: "custom-theme" })).rejects.toMatchObject({
      code: "quotaExceeded",
    })
    expect(errorListener).toHaveBeenCalledTimes(2)

    await expect(
      saveWorkspaces({ schemaVersion: 1, recent: [], lastOpened: "/vault" }),
    ).rejects.toMatchObject({ code: "quotaExceeded" })
    expect(errorListener).toHaveBeenCalledTimes(3)

    window.removeEventListener(SETTINGS_SAVE_ERROR_EVENT, errorListener)
  })

  it("migrates legacy unversioned settings and workspace config to schemaVersion 1", async () => {
    // Write legacy v0 settings without schemaVersion
    store.set(
      "amby:g:" + SETTINGS_FILE,
      JSON.stringify({
        panelScope: "workspace",
        defaultTheme: "solarized",
        prefs: { accent: "amber" },
      }),
    )

    const loaded = await loadSettings()
    expect(loaded.schemaVersion).toBe(1)
    expect(loaded.panelScope).toBe("workspace")
    expect(loaded.prefs.accent).toBe("amber")

    // Write legacy v0 workspace config without schemaVersion
    store.set(
      "amby:vmeta:" + WORKSPACE_FILE,
      JSON.stringify({
        theme: "nord",
        customPresets: [],
      }),
    )

    const loadedWs = await loadWorkspaceConfig()
    expect(loadedWs.schemaVersion).toBe(1)
    expect(loadedWs.theme).toBe("nord")
  })

  it("serializes concurrent patches without erasing parallel fields", async () => {
    await saveSettingsPatch({ panelScope: "workspace" })

    // Trigger two concurrent patches simultaneously
    const p1 = saveSettingsPatch({ defaultTheme: "nord" })
    const p2 = saveSettingsPatch({ prefs: { ...(await loadSettings()).prefs, fontScale: "lg" } })

    await Promise.all([p1, p2])

    const result = await loadSettings()
    expect(result.panelScope).toBe("workspace")
    expect(result.defaultTheme).toBe("nord")
    expect(result.prefs.fontScale).toBe("lg")
  })

  it("serializes concurrent session saves and surfaces failed session save", async () => {
    const errorListener = vi.fn()
    window.addEventListener(SETTINGS_SAVE_ERROR_EVENT, errorListener)

    const session: Parameters<typeof saveSession>[0] = {
      schemaVersion: 1,
      tabs: [{ fileId: "note-1", title: "Note 1" }],
      activeFileId: "note-1",
      favorites: ["note-1"],
      viewModes: { "note-1": "live" },
      nestedNotesPlacements: {},
      locked: [],
      icons: { "note-1": "📝" },
    }

    await saveSession(session)
    const loaded = await loadSession("/test/vault")
    expect(loaded.tabs).toHaveLength(1)
    expect(loaded.icons["note-1"]).toBe("📝")

    // Now fail subsequent session save
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {
        throw new Error("read only filesystem")
      },
      removeItem: () => {},
      clear: () => {},
    })

    await expect(saveSession(session)).rejects.toMatchObject({ code: "unavailable" })
    expect(errorListener).toHaveBeenCalled()

    window.removeEventListener(SETTINGS_SAVE_ERROR_EVENT, errorListener)
  })

  it("migrates legacy plaintext apiKey to secure credential store and rewrites settings.json without secret", async () => {
    // Write legacy settings with a plaintext API key in AI model
    store.set(
      "amby:g:" + SETTINGS_FILE,
      JSON.stringify({
        schemaVersion: 1,
        panelScope: "global",
        ai: {
          models: [
            {
              id: "openai-model-1",
              label: "OpenAI GPT-4",
              provider: "openai",
              model: "gpt-4o",
              baseUrl: "",
              apiKey: "sk-proj-super-secret-key-12345678",
              apiVersion: "",
            },
          ],
          activeModelId: "openai-model-1",
        },
      }),
    )

    const loaded = await loadSettings()
    const model = loaded.ai.models[0]
    expect(model.id).toBe("openai-model-1")
    expect(model.credentialId).toBeDefined()
    expect(typeof model.credentialId).toBe("string")
    expect((model as { apiKey?: string }).apiKey).toBeUndefined()

    // Check credential store
    const storedSecret = store.get("amby:cred:" + model.credentialId!)
    expect(storedSecret).toBe("sk-proj-super-secret-key-12345678")

    // Check rewritten settings.json in storage: MUST NOT contain apiKey
    const savedRaw = store.get("amby:g:" + SETTINGS_FILE)!
    expect(savedRaw).not.toContain("sk-proj-super-secret-key-12345678")
    expect(savedRaw).not.toContain('"apiKey"')
    expect(savedRaw).toContain(model.credentialId)
  })
})
