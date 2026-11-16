import { afterEach, describe, expect, it, vi } from "vitest"
import { commands } from "../bindings"
import { DesktopAdapter } from "./desktop-adapter"

describe("vault-meta writes are bound to the vault generation (IPC-11)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("passes the generation the caller captured to the backend", async () => {
    const write = vi
      .spyOn(commands, "writeVaultMeta")
      .mockResolvedValue({ status: "ok", data: null })
    const adapter = new DesktopAdapter()
    await adapter.writeVaultRaw("session.json", "{}", 7)
    await adapter.writeVaultRaw("session.json", "{}")
    expect(write).toHaveBeenNthCalledWith(1, "session.json", "{}", 7)
    expect(write).toHaveBeenNthCalledWith(2, "session.json", "{}", null)
  })

  it("surfaces a stale-generation refusal", async () => {
    vi.spyOn(commands, "writeVaultMeta").mockResolvedValue({
      status: "error",
      error: "vaultGenerationConflict",
    })
    await expect(new DesktopAdapter().writeVaultRaw("session.json", "{}", 6)).rejects.toBeDefined()
  })
})
