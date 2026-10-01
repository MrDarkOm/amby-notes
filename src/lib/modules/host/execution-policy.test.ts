import { describe, expect, it } from "vitest"
import { moduleHost } from "./module-host"
import { INSTALLED_MODULE_EXECUTION_ENABLED, canExecuteInstalledModules } from "./execution-policy"

describe("installed module execution policy", () => {
  it("keeps third-party module execution disabled until isolation is verified", async () => {
    expect(INSTALLED_MODULE_EXECUTION_ENABLED).toBe(false)
    expect(canExecuteInstalledModules()).toBe(false)
    // An installed package is never imported into the privileged renderer.
    await expect(moduleHost.loadInstalledModule("example.community-plugin")).resolves.toBeNull()
  })
})
