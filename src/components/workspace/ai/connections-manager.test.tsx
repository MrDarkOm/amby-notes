// @vitest-environment happy-dom
import * as React from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { ConnectionsManager } from "./connections-manager"
import type { AiConnectionsSettings } from "./connections"
import * as ai from "@/lib/ai"
import * as storage from "@/lib/storage"
import { confirm } from "@/lib/confirm"
import { useAppNoticesStore } from "../notices/use-app-notices-store"

vi.mock("@/lib/ai", async (original) => ({
  ...(await original<typeof import("@/lib/ai")>()),
  aiCodexStatus: vi.fn(),
  aiCodexLogin: vi.fn(),
  aiCodexLoginCancel: vi.fn(),
  aiCodexLogout: vi.fn(),
  aiModelCatalog: vi.fn(),
  aiLocalAppInstalled: vi.fn(),
}))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  deleteUnreferencedAiCredential: vi.fn().mockResolvedValue(undefined),
  deleteAiCredential: vi.fn().mockResolvedValue(undefined),
  openWebAddress: vi.fn().mockResolvedValue(undefined),
  storeAiCredential: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn().mockResolvedValue(true) }))

const settings: AiConnectionsSettings = {
  version: 1,
  activeModelId: null,
  connections: [
    {
      id: "local",
      provider: "ollama",
      method: "api",
      label: "Home",
      baseUrl: "",
      credentialId: null,
      apiVersion: "",
    },
  ],
  models: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(confirm).mockResolvedValue(true)
  useAppNoticesStore.setState(useAppNoticesStore.getInitialState())
  vi.mocked(ai.aiModelCatalog).mockResolvedValue([
    { model: "llama", label: "Llama", supportsTools: null },
  ])
})
afterEach(cleanup)

function Harness({ fail = false }: { fail?: boolean }) {
  const [value, setValue] = React.useState(settings)
  return (
    <ConnectionsManager
      settings={value}
      onCommit={async (next) => {
        if (fail) throw new Error("write")
        setValue(next)
      }}
    />
  )
}

describe("connection settings", () => {
  it("loads a catalog automatically and enables the first models and lets the user disable one", async () => {
    render(<Harness />)
    const toggle = await screen.findByRole("switch", { name: "Включить модель Llama" })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"))
    expect(screen.queryByLabelText("Поиск моделей")).toBeNull()
  })

  it("shows a saving error without changing the saved selection", async () => {
    render(<Harness fail />)
    await screen.findByRole("alert")
    expect(screen.queryByRole("switch", { name: "Включить модель Llama" })).toBeNull()
  })

  it("offers the download page of a local program that is not on the computer", async () => {
    vi.mocked(ai.aiLocalAppInstalled).mockResolvedValue(false)
    render(<Harness />)
    fireEvent.click(await screen.findByRole("button", { name: "Добавить провайдера" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Провайдер" }))
    fireEvent.click(await screen.findByRole("option", { name: /LM Studio/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Скачать LM Studio" }))
    expect(storage.openWebAddress).toHaveBeenCalledWith("https://lmstudio.ai/download")
  })

  it("offers nothing when the program is found or cannot be told", async () => {
    vi.mocked(ai.aiLocalAppInstalled).mockResolvedValue(true)
    render(<Harness />)
    fireEvent.click(await screen.findByRole("button", { name: "Добавить провайдера" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Провайдер" }))
    fireEvent.click(await screen.findByRole("option", { name: /Ollama/ }))
    await waitFor(() => expect(ai.aiLocalAppInstalled).toHaveBeenCalledWith("ollama"))
    expect(screen.queryByRole("button", { name: /Скачать/ })).toBeNull()
  })

  it("lets the user mark a model as able to call tools", async () => {
    render(<Harness />)
    const tools = await screen.findByRole("button", { name: "Инструменты модели Llama" })
    expect(tools.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(tools)
    await waitFor(() => expect(tools.getAttribute("aria-pressed")).toBe("true"))
  })

  it("allows a local custom model", async () => {
    render(<Harness />)
    await screen.findByRole("switch", { name: "Включить модель Llama" })
    fireEvent.change(screen.getByLabelText("ID модели"), { target: { value: "mine" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить локальную модель" }))
    expect(await screen.findByRole("switch", { name: "Включить модель mine" })).toBeTruthy()
  })
  it("shows installation guidance for missing Codex and never offers a cloud custom model", async () => {
    vi.mocked(ai.aiCodexStatus).mockResolvedValue({
      installed: false,
      supported: false,
      signedIn: false,
    })
    const codex: AiConnectionsSettings = {
      version: 1,
      activeModelId: null,
      models: [],
      connections: [
        {
          id: "cli",
          provider: "openai",
          method: "codex-cli",
          label: "Codex",
          baseUrl: "",
          credentialId: null,
          apiVersion: "",
        },
      ],
    }
    render(<ConnectionsManager settings={codex} onCommit={vi.fn().mockResolvedValue(undefined)} />)
    expect(await screen.findByText("Codex CLI не установлен.")).toBeTruthy()
    expect(screen.getByRole("img", { name: "не установлен" }).className).toContain("bg-red-500")
    expect(screen.getByRole("button", { name: "Инструкция по установке" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Проверить снова" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Добавить локальную модель" })).toBeNull()
    expect(ai.aiModelCatalog).not.toHaveBeenCalled()
  })
  it("moves a model with the arrows and collapses the card", async () => {
    render(<Harness />)
    await screen.findByRole("switch", { name: "Включить модель Llama" })
    expect(
      (screen.getByRole("button", { name: "Поднять модель Llama" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    const toggle = screen.getAllByRole("button", { expanded: true })[0]
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
  })
  it("offers a search only for a long catalog", async () => {
    vi.mocked(ai.aiModelCatalog).mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        model: `m${index}`,
        label: `Model ${index}`,
        supportsTools: null,
      })),
    )
    render(<Harness />)
    await screen.findByRole("switch", { name: "Включить модель Model 0" })
    fireEvent.change(screen.getByLabelText("Поиск моделей"), { target: { value: "missing" } })
    expect(screen.queryByRole("switch", { name: "Включить модель Model 0" })).toBeNull()
  })
  it("saves two cards loading their catalogs at once without a stale base", async () => {
    const two: AiConnectionsSettings = {
      ...settings,
      connections: [
        settings.connections[0],
        { ...settings.connections[0], id: "other", label: "Other" },
      ],
    }
    let file = two
    const Racing = () => {
      const [value, setValue] = React.useState(two)
      return (
        <ConnectionsManager
          settings={value}
          onCommit={async (next, expected) => {
            // Like the real file: a change built on an older copy is refused.
            if (JSON.stringify(file) !== JSON.stringify(expected))
              throw new Error("settingsChanged")
            await new Promise((resolve) => setTimeout(resolve, 20))
            file = next
            setValue(next)
          }}
        />
      )
    }
    render(<Racing />)
    await waitFor(() => expect(file.models.length).toBe(2))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(file.connections.every((connection) => connection.catalogUpdatedAt)).toBe(true)
  })
  it("repeats a change on what another window saved instead of failing", async () => {
    let file: AiConnectionsSettings = {
      ...settings,
      activeModelId: null,
      models: [
        {
          id: "m1",
          connectionId: "local",
          model: "llama",
          label: "Llama",
          enabled: false,
          available: true,
          origin: "local",
        },
      ],
      connections: [{ ...settings.connections[0], catalogUpdatedAt: "2026-01-01T00:00:00.000Z" }],
    }
    const shown = file
    // Another window moves the active model after this screen loaded.
    file = { ...file, activeModelId: "m1" }
    const Stale = () => {
      const [value, setValue] = React.useState(shown)
      return (
        <ConnectionsManager
          settings={value}
          onCommit={async (next, expected) => {
            if (JSON.stringify(file) !== JSON.stringify(expected))
              throw new Error("settingsChanged")
            file = next
            setValue(next)
          }}
          onConflict={async () => {
            setValue(file)
            return file
          }}
        />
      )
    }
    render(<Stale />)
    fireEvent.click(await screen.findByRole("switch", { name: "Включить модель Llama" }))
    await waitFor(() => expect(file.models[0].enabled).toBe(true))
    expect(file.activeModelId).toBe("m1")
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("marks a base model with a star only on an enabled model", async () => {
    render(<Harness />)
    const star = await screen.findByRole("button", {
      name: "Базовая модель для новых бесед: Llama",
    })
    expect(star.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(star)
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"))
    fireEvent.click(await screen.findByRole("switch", { name: "Включить модель Llama" }))
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("false"))
    expect((star as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("removing a connection asks in the application", () => {
  const withKey: AiConnectionsSettings = {
    ...settings,
    connections: [
      { ...settings.connections[0], id: "keyed", provider: "openai", credentialId: "cred-1" },
    ],
  }
  const removeButton = () => screen.findByRole("button", { name: "Удалить подключение" })

  it("is a dangerous question that names the connection; cancel removes nothing", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const onCommit = vi.fn(async (_next: AiConnectionsSettings) => {})
    render(<ConnectionsManager settings={withKey} onCommit={onCommit} />)
    fireEvent.click(await removeButton())
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.destructive).toBe(true)
    expect(question.title).toContain("Home")
    expect(question.confirmLabel).toBe("Удалить")
    // (The panel saves the catalog it loads by itself; what must not happen is a save without the connection.)
    expect(onCommit.mock.calls.some(([next]) => next.connections.length === 0)).toBe(false)
    expect(storage.deleteUnreferencedAiCredential).not.toHaveBeenCalled()
  })

  it("removes the connection and its key after yes", async () => {
    const onCommit = vi.fn(async (_next: AiConnectionsSettings) => {})
    render(<ConnectionsManager settings={withKey} onCommit={onCommit} />)
    fireEvent.click(await removeButton())
    await waitFor(() =>
      expect(onCommit.mock.calls.some(([next]) => next.connections.length === 0)).toBe(true),
    )
    expect(storage.deleteUnreferencedAiCredential).toHaveBeenCalledWith("cred-1")
  })

  it("says that the old key stayed in the centre when it could not be deleted: the card is gone", async () => {
    vi.mocked(storage.deleteUnreferencedAiCredential).mockRejectedValue(new Error("keychain"))
    const onCommit = vi.fn(async (_next: AiConnectionsSettings) => {})
    render(<ConnectionsManager settings={withKey} onCommit={onCommit} />)
    fireEvent.click(await removeButton())
    await waitFor(() => expect(useAppNoticesStore.getState().notices).toHaveLength(1))
    const notice = useAppNoticesStore.getState().notices[0]
    expect(notice.level).toBe("warning")
    expect(JSON.stringify(notice)).not.toContain("keychain")
  })
})
