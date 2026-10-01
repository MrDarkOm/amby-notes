import { expect, it, vi } from "vitest"
import { stagePackage } from "./installer"
import { sha256Hex } from "./validator"
import { commands } from "@/lib/bindings"
import type { PackageManifest } from "./types"

vi.mock("@/lib/storage", () => ({ isTauri: () => true }))
vi.mock("@/lib/bindings", () => ({
  commands: {
    stageModulePackage: vi.fn(async () => ({
      status: "ok",
      data: { stagingId: "backend-generated" },
    })),
  },
}))

it("publishes using the staging handle returned by the backend", async () => {
  const content = "export const example = true"
  const manifest: PackageManifest = {
    formatVersion: 1,
    id: "example.plugin",
    name: "Example",
    version: "1.0.0",
    publisher: "Example",
    kind: "community",
    minAppVersion: "0.1.5",
    entry: "index.js",
    permissions: [],
    checksums: { "index.js": await sha256Hex(content) },
    signature: { keyId: "community", sig: "unsigned" },
  }
  const result = await stagePackage(manifest, { "index.js": content })
  expect(commands.stageModulePackage).toHaveBeenCalledOnce()
  expect(result.staged?.stagingId).toBe("backend-generated")
})
