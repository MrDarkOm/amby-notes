import { describe, expect, it } from "vitest"
import { eventLabelKey } from "./event-presentation"

describe("debug event labels", () => {
  it.each([
    ["storage.write_note", "info", "save"],
    ["autosave.failed", "warn", "error"],
    ["search.query.completed", "info", "search"],
    ["vault_index.rebuild", "info", "index"],
    ["watcher.external_change", "info", "watcher"],
    ["queue.flush", "debug", "queue"],
    ["custom.future_event", "info", "operation"],
  ] as const)("maps %s to a human event family", (event, level, family) => {
    expect(eventLabelKey(event, level)).toBe(`settings.debug.eventLabel.${family}`)
  })

  it("keeps failure severity as an error regardless of event code", () => {
    expect(eventLabelKey("storage.write_note", "error")).toBe("settings.debug.eventLabel.error")
  })
})
