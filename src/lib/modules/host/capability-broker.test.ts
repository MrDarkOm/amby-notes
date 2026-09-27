import { describe, expect, it } from "vitest"
import { CapabilityBroker, validateConfinedRelPath } from "./capability-broker"
import { SecurityPermissionError } from "./sdk"
import type { ModuleManifest } from "../types"

describe("validateConfinedRelPath", () => {
  it("accepts valid relative paths", () => {
    expect(validateConfinedRelPath("note.md")).toBe("note.md")
    expect(validateConfinedRelPath("sub/folder/note.md")).toBe("sub/folder/note.md")
    expect(validateConfinedRelPath("assets/image.png")).toBe("assets/image.png")
  })

  it("rejects absolute paths", () => {
    expect(() => validateConfinedRelPath("/etc/passwd")).toThrow(
      "Path traversal or absolute paths are rejected",
    )
    expect(() => validateConfinedRelPath("C:/Windows/system32")).toThrow(
      "Path traversal or absolute paths are rejected",
    )
  })

  it("rejects path traversal attempts", () => {
    expect(() => validateConfinedRelPath("../secret.txt")).toThrow(
      "Path traversal or absolute paths are rejected",
    )
    expect(() => validateConfinedRelPath("sub/../../secret.txt")).toThrow(
      "Path traversal or absolute paths are rejected",
    )
    expect(() => validateConfinedRelPath("..")).toThrow(
      "Path traversal or absolute paths are rejected",
    )
  })
})

describe("CapabilityBroker", () => {
  const readOnlyManifest: ModuleManifest = {
    formatVersion: 1,
    id: "test.readonly",
    name: "Read Only",
    version: "1.0.0",
    publisher: "Test",
    kind: "official",
    minAppVersion: "0.1.5",
    permissions: ["vault.read"],
  }

  const context = {
    moduleId: "test.readonly",
    vault: "/mock/vault",
    isSafeMode: false,
  }

  it("checks permissions correctly", () => {
    const broker = new CapabilityBroker(readOnlyManifest, context)
    expect(broker.hasPermission("vault.read")).toBe(true)
    expect(broker.hasPermission("vault.write")).toBe(false)
    expect(broker.hasPermission("network")).toBe(false)
  })

  it("throws SecurityPermissionError when required permission is missing", () => {
    const broker = new CapabilityBroker(readOnlyManifest, context)
    expect(() => broker.requirePermission("vault.read")).not.toThrow()
    expect(() => broker.requirePermission("vault.write")).toThrow(SecurityPermissionError)
  })
})
