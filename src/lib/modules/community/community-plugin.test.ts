import { describe, expect, it, beforeEach, vi } from "vitest"
import { CommunityPluginSandbox } from "./sandbox"
import { revocationRegistry } from "./revocation"
import { quarantineManager, safeModeState } from "../host/safe-mode"
import type { CommunityPluginManifest } from "./types"
import type { ModuleHostContext } from "../host/sdk"

vi.mock("@/lib/storage", () => ({
  readFile: vi.fn().mockImplementation(async (path: string) => `content of ${path}`),
  writeFile: vi.fn().mockImplementation(async () => {}),
}))

describe("CommunityPluginSandbox & RPC Security", () => {
  const baseManifest: CommunityPluginManifest = {
    formatVersion: 1,
    id: "community.test.plugin",
    name: "Test Community Plugin",
    version: "1.0.0",
    publisher: "ThirdParty",
    kind: "community",
    minAppVersion: "0.1.5",
    permissions: ["vault.read", "vault.write"],
  }

  const baseContext: ModuleHostContext = {
    moduleId: "community.test.plugin",
    vault: "/mock/vault",
    isSafeMode: false,
  }

  beforeEach(() => {
    revocationRegistry.clear()
    quarantineManager.clear()
  })

  it("blocks activation when Safe Mode is enabled", () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: { ...baseContext, isSafeMode: true },
    })

    const status = sandbox.canActivate()
    expect(status.allowed).toBe(false)
    expect(status.reason).toContain("Safe mode is enabled")
  })

  it("blocks activation when plugin is revoked", () => {
    revocationRegistry.registerRevocation({
      moduleId: "community.test.plugin",
      versionPattern: "1.0.0",
      reason: "Known malicious payload",
      revokedAt: "2026-09-20",
    })

    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: baseContext,
    })

    const status = sandbox.canActivate()
    expect(status.allowed).toBe(false)
    expect(status.reason).toContain("Known malicious payload")
  })

  it("blocks activation when plugin is quarantined", () => {
    quarantineManager.recordFailure("community.test.plugin", new Error("Crash 1"))
    quarantineManager.recordFailure("community.test.plugin", new Error("Crash 2"))
    quarantineManager.recordFailure("community.test.plugin", new Error("Crash 3"))

    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: baseContext,
    })

    const status = sandbox.canActivate()
    expect(status.allowed).toBe(false)
    expect(status.reason).toContain("quarantined")
  })

  it("allows reading confined vault files when vault.read permission is present", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: baseContext,
    })

    const res = await sandbox.handleRpcRequest({
      id: "req-1",
      method: "vault.readFile",
      params: { relPath: "notes/sample.md" },
    })

    expect(res.error).toBeUndefined()
    expect(res.result).toBe("content of /mock/vault/notes/sample.md")
  })

  it("denies reading vault files when vault.read permission is missing", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: { ...baseManifest, permissions: ["vault.write"] },
      context: baseContext,
    })

    const res = await sandbox.handleRpcRequest({
      id: "req-2",
      method: "vault.readFile",
      params: { relPath: "notes/sample.md" },
    })

    expect(res.error).toBeDefined()
    expect(res.error?.code).toBe("PERMISSION_DENIED")
  })

  it("rejects path traversal attempts even with vault.read permission", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: baseContext,
    })

    const traversalPaths = [
      "../secret.txt",
      "../../etc/passwd",
      "/absolute/path",
      "C:\\Windows\\system.ini",
    ]

    for (const badPath of traversalPaths) {
      const res = await sandbox.handleRpcRequest({
        id: "req-traversal",
        method: "vault.readFile",
        params: { relPath: badPath },
      })
      expect(res.error).toBeDefined()
      expect(res.error?.code).toBe("EXECUTION_ERROR")
      expect(res.error?.message).toContain("Invalid vault-relative path")
    }
  })

  it("denies network request when network permission is missing", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest, // no network permission
      context: baseContext,
    })

    const res = await sandbox.handleRpcRequest({
      id: "req-net-1",
      method: "network.fetch",
      params: { url: "https://api.github.com/repos" },
    })

    expect(res.error?.code).toBe("PERMISSION_DENIED")
  })

  it("denies network request when target domain is not in networkAllowlist", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: {
        ...baseManifest,
        permissions: ["network"],
        networkAllowlist: ["api.github.com"],
      },
      context: baseContext,
    })

    const res = await sandbox.handleRpcRequest({
      id: "req-net-2",
      method: "network.fetch",
      params: { url: "https://evil.com/steal" },
    })

    expect(res.error).toBeDefined()
    expect(res.error?.message).toContain('Network request to "evil.com" is not allowed')
  })

  it("rejects RPC requests after sandbox is terminated", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: baseContext,
    })

    sandbox.terminate()

    const res = await sandbox.handleRpcRequest({
      id: "req-term",
      method: "vault.readFile",
      params: { relPath: "notes/sample.md" },
    })

    expect(res.error?.code).toBe("TERMINATED")
  })

  it("Criterion 6: Isolated sandbox runtime blocks window, document, and host globals escape attempts", async () => {
    const sandbox = new CommunityPluginSandbox({
      manifest: baseManifest,
      context: baseContext,
    })

    // Test 1: Window access is blocked
    const windowEscape = await sandbox.executeCode(`
      return typeof window;
    `)
    expect(windowEscape.success).toBe(true)
    expect(windowEscape.result).toBe("undefined")

    // Test 2: Document access is blocked
    const docEscape = await sandbox.executeCode(`
      return typeof document;
    `)
    expect(docEscape.success).toBe(true)
    expect(docEscape.result).toBe("undefined")

    // Test 3: Direct attempt to read host secrets or invoke Tauri globals fails
    const tauriEscape = await sandbox.executeCode(`
      return typeof __TAURI__;
    `)
    expect(tauriEscape.success).toBe(true)
    expect(tauriEscape.result).toBe("undefined")

    // Test 4: Authorized RPC call via injected amby API succeeds inside the worker
    const validRpc = await sandbox.executeCode(`
      const text = await amby.vault.readFile("notes/sample.md");
      return text;
    `)
    expect(validRpc.success).toBe(true)
    expect(validRpc.result).toBe("content of /mock/vault/notes/sample.md")

    // Test 5: Unauthorized path traversal via injected amby API is rejected
    const badTraversal = await sandbox.executeCode(`
      try {
        await amby.vault.readFile("../../../etc/shadow");
        return "escaped";
      } catch (e) {
        return "blocked:" + e.message;
      }
    `)
    expect(badTraversal.success).toBe(true)
    expect(badTraversal.result).toContain("blocked:Invalid vault-relative path")

    sandbox.terminate()
  })

  it("Criterion 4: Quarantine and SafeMode state persist across simulated app restarts", () => {
    // 1. Record failures to trigger quarantine
    quarantineManager.clear()
    expect(quarantineManager.isQuarantined("test.quarantine.persistence")).toBe(false)
    quarantineManager.recordFailure("test.quarantine.persistence", new Error("err1"))
    quarantineManager.recordFailure("test.quarantine.persistence", new Error("err2"))
    quarantineManager.recordFailure("test.quarantine.persistence", new Error("err3"))
    expect(quarantineManager.isQuarantined("test.quarantine.persistence")).toBe(true)

    // 2. Simulate application restart by instantiating a fresh QuarantineManager
    const freshQuarantineManager = new (
      quarantineManager.constructor as new () => typeof quarantineManager
    )()
    expect(freshQuarantineManager.isQuarantined("test.quarantine.persistence")).toBe(true)
    const records = freshQuarantineManager.getQuarantinedModules()
    expect(records.some((r) => r.moduleId === "test.quarantine.persistence")).toBe(true)

    // 3. Test SafeMode persistence across restart
    safeModeState.setEnabled(true)
    const freshSafeModeState = new (safeModeState.constructor as new () => typeof safeModeState)()
    expect(freshSafeModeState.isEnabled()).toBe(true)
    freshSafeModeState.setEnabled(false)
  })
})
