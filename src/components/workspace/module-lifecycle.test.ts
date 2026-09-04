import { afterEach, describe, expect, it, vi } from "vitest"

import { findModule } from "./modules"
import { transitionModuleLifecycle } from "./module-lifecycle"

describe("module lifecycle", () => {
  const module = findModule("history")

  afterEach(() => {
    if (module) {
      delete module.prepareDeactivate
      delete module.onDeactivate
    }
    vi.restoreAllMocks()
  })

  it("does not commit a module-off transition when flush fails", async () => {
    if (!module) throw new Error("history module is not registered")
    const onDeactivate = vi.fn()
    module.prepareDeactivate = vi.fn(async () => {
      throw new Error("pending work")
    })
    module.onDeactivate = onDeactivate

    const result = await transitionModuleLifecycle([module.id], [], { vault: "/vault" })

    expect(result.ok).toBe(false)
    expect(onDeactivate).not.toHaveBeenCalled()
  })

  it("commits only after every removed module has flushed", async () => {
    if (!module) throw new Error("history module is not registered")
    const events: string[] = []
    module.prepareDeactivate = vi.fn(async () => {
      events.push("prepare")
    })
    module.onDeactivate = vi.fn(() => {
      events.push("commit")
    })

    const result = await transitionModuleLifecycle([module.id], [], { vault: "/vault" })

    expect(result).toEqual({ ok: true })
    expect(events).toEqual(["prepare", "commit"])
  })
})
