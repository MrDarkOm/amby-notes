// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { ModelsManager } from "@/components/workspace/models-manager"
import type { AiSettings } from "@/components/workspace/app-config"
import { deleteAiCredential, inspectAiCredential, storeAiCredential } from "@/lib/storage"

vi.mock("@/lib/storage", () => ({
  deleteAiCredential: vi.fn(),
  inspectAiCredential: vi.fn(),
  storeAiCredential: vi.fn(),
}))

const ai: AiSettings = {
  activeModelId: "test-model",
  models: [
    {
      id: "test-model",
      label: "Test",
      provider: "openai",
      model: "test",
      baseUrl: "http://127.0.0.1:1",
      credentialId: null,
      apiVersion: "",
    },
  ],
}

function setup(credentialId: string | null = null) {
  const onChange = vi.fn()
  const { container } = render(
    <ModelsManager
      ai={{ ...ai, models: [{ ...ai.models[0], credentialId }] }}
      onChange={onChange}
    />,
  )
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
  return { onChange, input }
}

function save(input: HTMLInputElement, secret = "synthetic-test-key") {
  fireEvent.change(input, { target: { value: secret } })
  fireEvent.keyDown(input, { key: "Enter" })
}

describe("ModelsManager credential safety", () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    await i18n.changeLanguage("ru")
    vi.mocked(storeAiCredential).mockResolvedValue(undefined)
    vi.mocked(deleteAiCredential).mockResolvedValue(undefined)
    vi.mocked(inspectAiCredential).mockResolvedValue({ exists: true, masked: "syn••••-key" })
  })
  afterEach(cleanup)

  it("persists only a verified credential reference, never the secret", async () => {
    const { input, onChange } = setup()
    save(input)
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    const id = vi.mocked(storeAiCredential).mock.calls[0][0]
    expect(inspectAiCredential).toHaveBeenCalledWith(id)
    expect(onChange.mock.calls[0][0].models[0].credentialId).toBe(id)
    expect(JSON.stringify(onChange.mock.calls)).not.toContain("synthetic-test-key")
    expect(input.value).toBe("")
    expect(input.placeholder).toBe("syn••••-key")
  })

  it.each(["store", "inspect", "missing"])(
    "does not persist a dangling credentialId on %s failure",
    async (failure) => {
      if (failure === "store") vi.mocked(storeAiCredential).mockRejectedValue("private detail")
      if (failure === "inspect") vi.mocked(inspectAiCredential).mockRejectedValue("private detail")
      if (failure === "missing")
        vi.mocked(inspectAiCredential).mockResolvedValue({ exists: false, masked: null })
      const { input, onChange } = setup()
      save(input)
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toBe(i18n.t("models.keychainError"))
      expect(alert.textContent).not.toContain("private detail")
      expect(onChange).not.toHaveBeenCalled()
      expect(input.value).toBe("synthetic-test-key")
    },
  )

  it("handles a rejected initial inspect with a localized alert", async () => {
    await i18n.changeLanguage("en")
    vi.mocked(inspectAiCredential).mockRejectedValue("private detail")
    const { onChange } = setup("existing-test-id")
    expect((await screen.findByRole("alert")).textContent).toBe(i18n.t("models.keychainError"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("routes a whitespace update to deletion and clears the verified reference", async () => {
    const { input, onChange } = setup("existing-test-id")
    await waitFor(() => expect(input.placeholder).toBe("syn••••-key"))
    vi.mocked(inspectAiCredential).mockResolvedValue({ exists: false, masked: null })
    save(input, "   ")
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(storeAiCredential).toHaveBeenCalledWith("existing-test-id", "")
    expect(onChange.mock.calls[0][0].models[0].credentialId).toBeNull()
  })

  it("does not claim whitespace deletion succeeded when the entry still exists", async () => {
    const { input, onChange } = setup("existing-test-id")
    await waitFor(() => expect(input.placeholder).toBe("syn••••-key"))
    save(input, "   ")
    await screen.findByRole("alert")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("serializes blur and submit while the same credential save is pending", async () => {
    let finish!: () => void
    vi.mocked(storeAiCredential).mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const { input, onChange } = setup()
    save(input)
    fireEvent.blur(input)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(storeAiCredential).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
  })

  it("keeps the model and reference when deletion fails", async () => {
    vi.mocked(deleteAiCredential).mockRejectedValue("private detail")
    const { input, onChange } = setup("existing-test-id")
    await waitFor(() => expect(input.placeholder).toBe("syn••••-key"))
    fireEvent.click(screen.getByTitle(i18n.t("models.clearKey")))
    await screen.findByRole("alert")
    expect(onChange).not.toHaveBeenCalled()
  })
})
