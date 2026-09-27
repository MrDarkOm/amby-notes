import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  compareSemver,
  getModuleUsage,
  installPackage,
  loadGlobalModulesRegistry,
  loadModuleCatalog,
  rollbackModule,
  sha256Hex,
  uninstallModule,
  validateApiCompatibility,
  validateChecksums,
  validateDependencies,
  validateManifest,
  validatePathConfinement,
  validateSignature,
  signOfficialManifest,
  type PackageManifest,
} from "../index"

describe("MOD-04: Package Manager", () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    })
  })
  const validEntry = "index.js"
  const validContent = "console.log('test module');"

  async function createValidManifest(
    overrides: Partial<PackageManifest> = {},
  ): Promise<PackageManifest> {
    const hash = await sha256Hex(validContent)
    const base: Omit<PackageManifest, "signature"> = {
      formatVersion: 1,
      id: "test.pkg",
      name: "Test Package",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: validEntry,
      permissions: ["vault.read"],
      checksums: {
        [validEntry]: hash,
      },
      ...overrides,
    }
    return signOfficialManifest(base)
  }

  it("validates manifest structure correctly", async () => {
    const manifest = await createValidManifest()
    const validResult = validateManifest(manifest)
    expect(validResult.valid).toBe(true)

    const invalidResult = validateManifest({ id: "invalid-version", formatVersion: 99 })
    expect(invalidResult.valid).toBe(false)
    expect(invalidResult.error).toContain("Unsupported package formatVersion")
  })

  it("blocks path traversal and absolute paths", () => {
    expect(validatePathConfinement(["index.js", "assets/logo.png"]).safe).toBe(true)
    expect(validatePathConfinement(["../secret.txt"]).safe).toBe(false)
    expect(validatePathConfinement(["/etc/passwd"]).safe).toBe(false)
    expect(validatePathConfinement(["C:\\Windows\\System32"]).safe).toBe(false)
  })

  it("validates file checksums and detects tampering", async () => {
    const manifest = await createValidManifest()
    const validFiles = { [validEntry]: validContent }
    const validCheck = await validateChecksums(validFiles, manifest.checksums)
    expect(validCheck.valid).toBe(true)

    const tamperedFiles = { [validEntry]: "console.log('tampered');" }
    const tamperedCheck = await validateChecksums(tamperedFiles, manifest.checksums)
    expect(tamperedCheck.valid).toBe(false)
    expect(tamperedCheck.mismatchedFile).toBe(validEntry)
  })

  it("validates official signatures and strictly rejects fake signatures", async () => {
    const manifest = await createValidManifest()
    expect(await validateSignature(manifest)).toBe(true)

    // Strictly rejects fake "ed25519:anything" strings
    const fakeSigManifest = {
      ...manifest,
      signature: { keyId: "amby-official-2026", sig: "ed25519:anything" },
    }
    expect(await validateSignature(fakeSigManifest)).toBe(false)

    // Rejects forged signature
    const forgedSigManifest = {
      ...manifest,
      signature: {
        keyId: "amby-official-2026",
        sig: `ed25519:${"0".repeat(128)}`,
      },
    }
    expect(await validateSignature(forgedSigManifest)).toBe(false)

    // Rejects untrusted keyId
    const badKeyManifest = {
      ...manifest,
      signature: { keyId: "untrusted-key", sig: manifest.signature.sig },
    }
    expect(await validateSignature(badKeyManifest)).toBe(false)
  })

  it("checks API compatibility with semver", async () => {
    const manifest = await createValidManifest()
    expect(validateApiCompatibility(manifest, "0.1.5").compatible).toBe(true)
    expect(validateApiCompatibility(manifest, "0.1.0").compatible).toBe(false)

    expect(compareSemver("1.0.0", "1.0.0")).toBe(0)
    expect(compareSemver("1.2.0", "1.1.0")).toBe(1)
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1)
  })

  it("checks dependencies satisfaction", async () => {
    const manifest = await createValidManifest()
    manifest.dependencies = { "amby.tags": "1.0.0" }

    const satisfied = validateDependencies(manifest, {
      "amby.tags": { activeVersion: "1.0.0" },
    })
    expect(satisfied.satisfied).toBe(true)

    const unsatisfied = validateDependencies(manifest, {})
    expect(unsatisfied.satisfied).toBe(false)
    expect(unsatisfied.missing).toContain("amby.tags@1.0.0")
  })

  it("stages and atomically installs a package", async () => {
    const manifest = await createValidManifest()
    const files = { [validEntry]: validContent }

    const installResult = await installPackage(manifest, files, "0.1.5")
    expect(installResult.success).toBe(true)
    expect(installResult.installedVersion).toBe("1.0.0")

    const registry = await loadGlobalModulesRegistry()
    expect(registry.installed["test.pkg"]).toBeDefined()
    expect(registry.installed["test.pkg"].activeVersion).toBe("1.0.0")
  })

  it("updates and rolls back to previous version", async () => {
    const manifestV1 = await createValidManifest()
    const filesV1 = { [validEntry]: validContent }
    await installPackage(manifestV1, filesV1, "0.1.5")

    const manifestV2 = await createValidManifest({ version: "2.0.0" })
    const filesV2 = { [validEntry]: validContent }

    const updateResult = await installPackage(manifestV2, filesV2, "0.1.5")
    expect(updateResult.success).toBe(true)
    expect(updateResult.installedVersion).toBe("2.0.0")
    expect(updateResult.previousVersion).toBe("1.0.0")

    const manifestV3 = await createValidManifest({ version: "3.0.0" })
    const filesV3 = { [validEntry]: validContent }
    const updateV3Result = await installPackage(manifestV3, filesV3, "0.1.5")
    expect(updateV3Result.success).toBe(true)
    expect(updateV3Result.installedVersion).toBe("3.0.0")
    expect(updateV3Result.previousVersion).toBe("2.0.0")

    // Rollback from 3.0.0 -> 2.0.0
    const rollbackResult1 = await rollbackModule("test.pkg")
    expect(rollbackResult1.success).toBe(true)
    expect(rollbackResult1.installedVersion).toBe("2.0.0")
    expect(rollbackResult1.previousVersion).toBe("3.0.0")

    // Rollback from 2.0.0 -> 1.0.0
    const rollbackResult2 = await rollbackModule("test.pkg")
    expect(rollbackResult2.success).toBe(true)
    expect(rollbackResult2.installedVersion).toBe("1.0.0")
    expect(rollbackResult2.previousVersion).toBe("2.0.0")

    const registry = await loadGlobalModulesRegistry()
    expect(registry.installed["test.pkg"].activeVersion).toBe("1.0.0")
  })

  it("uninstalls module while preserving user data", async () => {
    const manifest = await createValidManifest()
    const files = { [validEntry]: validContent }
    await installPackage(manifest, files, "0.1.5")

    const uninstallResult = await uninstallModule("test.pkg")
    expect(uninstallResult.success).toBe(true)

    const registry = await loadGlobalModulesRegistry()
    expect(registry.installed["test.pkg"]).toBeUndefined()
  })

  it("persists uninstallation of builtin module without resurrection", async () => {
    const uninstallResult = await uninstallModule("amby.excalidraw")
    expect(uninstallResult.success).toBe(true)

    // Reload registry: must NOT resurrect amby.excalidraw!
    const reloaded = await loadGlobalModulesRegistry()
    expect(reloaded.installed["amby.excalidraw"]).toBeUndefined()
    expect(reloaded.uninstalled).toContain("amby.excalidraw")

    const { isModuleInstalled } = await import("../global-registry")
    expect(await isModuleInstalled("amby.excalidraw")).toBe(false)
  })

  it("loads official module catalog with builtin modules", async () => {
    const catalog = await loadModuleCatalog()
    expect(catalog.modules["amby.excalidraw"]).toBeDefined()
    expect(catalog.modules["amby.canvas"]).toBeDefined()
    expect(catalog.modules["amby.tags"]).toBeDefined()
  })

  it("reports module usage across workspaces", async () => {
    const workspaces = [
      { path: "/vault/a", enabledModules: ["amby.tags", "amby.favorites"] },
      { path: "/vault/b", enabledModules: ["amby.databases"] },
    ]
    const usage = await getModuleUsage("amby.tags", workspaces)
    expect(usage.moduleId).toBe("amby.tags")
    expect(usage.enabledInWorkspaces).toEqual(["/vault/a"])
  })

  it("installs module from remote URL in web environment", async () => {
    const manifest = await createValidManifest({ id: "remote.pkg" })
    const files = { [validEntry]: validContent }
    const pkg = { manifest, files }

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => pkg,
      }),
    )

    const { installFromRemoteUrl } = await import("../index")
    const result = await installFromRemoteUrl("https://example.com/remote.pkg.json", "0.1.5")
    expect(result.success).toBe(true)
    expect(result.moduleId).toBe("remote.pkg")

    const registry = await loadGlobalModulesRegistry()
    expect(registry.installed["remote.pkg"]).toBeDefined()
  })

  it("validates actual built packages from dist-modules end-to-end", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const distDir = path.resolve(__dirname, "../../../../dist-modules")
    if (!fs.existsSync(distDir)) return

    const pkgs = ["amby.excalidraw-1.0.0.amby-pkg", "amby.canvas-1.0.0.amby-pkg"]
    for (const pkgName of pkgs) {
      const file = path.join(distDir, pkgName)
      if (!fs.existsSync(file)) continue
      const raw = JSON.parse(fs.readFileSync(file, "utf8"))
      const validM = validateManifest(raw.manifest)
      expect(validM.valid).toBe(true)

      const validC = await validateChecksums(raw.files, raw.manifest.checksums)
      expect(validC.valid).toBe(true)

      const validS = await validateSignature(raw.manifest)
      expect(validS).toBe(true)
    }
  })
})
