// What the notification centre says now (docs/notices.md, section 5): the sections "Needs a decision" and
// "Attention" are not kept, they are derived from the live causes each time. Pure derivation.
import { describe, expect, it } from "vitest"
import {
  centreCounter,
  deriveCentre,
  noteNoticeId,
  reconcileHidden,
  type CentreInput,
} from "./centre-entries"

const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: "Заметки/идея.md",
  copyPath: "Заметки/идея.0123456789ab-conflict.md",
  createdMs: 1_760_000_000_000,
}

function input(patch: Partial<CentreInput> = {}): CentreInput {
  // By default every open note has its tab.
  return {
    tabbedDocIds: Object.keys(patch.openDocs ?? {}),
    vault: "/vault",
    conflicts: [],
    stop: null,
    limits: [],
    itemErrors: 0,
    openDocs: {},
    externalConflicts: {},
    saveFailed: {},
    propertyFailed: {},
    draftOffers: {},
    remoteDeleted: [],
    closedSaveFailures: {},
    hidden: [],
    ...patch,
  }
}

const doc = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  path: `/vault/Заметки/${id}.md`,
  ...patch,
})

const ids = (entries: Array<{ id: string }>) => entries.map((entry) => entry.id)

describe("what needs a decision", () => {
  it("is empty when nothing is wrong", () => {
    expect(deriveCentre(input())).toEqual({ decision: [], warning: [] })
  })

  it("has every sync conflict, as a decision", () => {
    const { decision } = deriveCentre(
      input({ conflicts: [conflict, { ...conflict, id: "ba9876543210" }] }),
    )
    expect(ids(decision)).toEqual(["sync-conflict:0123456789ab", "sync-conflict:ba9876543210"])
    expect(decision.every((entry) => entry.level === "decision")).toBe(true)
  })

  it.each([
    [{ kind: "massChange", direction: "incoming", total: 40, files: [] }],
    [{ kind: "vaultMissing" }],
    [{ kind: "vaultEmpty" }],
    [{ kind: "serverReset" }],
    [{ kind: "serverBehind" }],
    [{ kind: "rollback" }],
    [{ kind: "authRequired" }],
    [{ kind: "incompatibleServer" }],
  ])("has the stop of the sync %j, as a decision that leads to the settings", (stop) => {
    const { decision } = deriveCentre(input({ stop: stop as CentreInput["stop"] }))
    expect(decision).toHaveLength(1)
    expect(decision[0]).toMatchObject({
      id: `sync-stop:${stop.kind}`,
      level: "decision",
      kind: "sync-stop",
      action: { kind: "settings" },
    })
  })

  it("has a failed autosave of a note that is not open, as danger, with a way to the note", () => {
    const { decision } = deriveCentre(
      input({ closedSaveFailures: { "note-1": { name: "идея", path: "Заметки/идея.md" } } }),
    )
    expect(decision).toHaveLength(1)
    expect(decision[0]).toMatchObject({
      id: "closed-save-failed:note-1",
      level: "danger",
      name: "идея",
      action: { kind: "note", id: "note-1" },
    })
  })

  it("does not show a failed autosave twice once its note is open: the open note has it", () => {
    const { decision } = deriveCentre(
      input({
        closedSaveFailures: { "note-1": { name: "идея", path: "Заметки/идея.md" } },
        openDocs: { "note-1": doc("note-1") },
        saveFailed: { "note-1": true },
      }),
    )
    expect(ids(decision)).toEqual([noteNoticeId("note-1", "save-failed")])
  })
})

describe("the copies of the cards of the open notes", () => {
  it.each([
    ["save-failed", "danger", { saveFailed: { n: true } }],
    ["property-failed", "danger", { propertyFailed: { n: true } }],
    ["external-change", "decision", { externalConflicts: { n: {} } }],
    ["draft", "decision", { draftOffers: { n: { accept() {}, reject() {} } } }],
  ])("has the %s of an open note as %s, with a way to the note", (card, level, patch) => {
    const { decision } = deriveCentre(
      input({ openDocs: { n: doc("n") }, ...(patch as Partial<CentreInput>) }),
    )
    expect(decision).toHaveLength(1)
    expect(decision[0]).toMatchObject({
      id: noteNoticeId("n", card),
      level,
      action: { kind: "note", id: "n" },
    })
  })

  it("has a note whose file was deleted as a decision (К12)", () => {
    const { decision } = deriveCentre(
      input({ openDocs: { n: doc("n", { externallyDeleted: true }) } }),
    )
    expect(decision[0]).toMatchObject({
      id: noteNoticeId("n", "external-deleted"),
      level: "decision",
    })
  })

  it("has a note deleted on another computer, but only when it is open", () => {
    const open = deriveCentre(input({ openDocs: { n: doc("n") }, remoteDeleted: ["Заметки/n.md"] }))
    expect(open.decision.map((entry) => entry.id)).toEqual([noteNoticeId("n", "remote-deleted")])
    const closed = deriveCentre(input({ remoteDeleted: ["Заметки/n.md"] }))
    expect(closed.decision).toEqual([])
  })

  it("has no copy for a note whose tab is closed, though its text is still kept (no dead cards)", () => {
    const { decision } = deriveCentre(
      input({
        openDocs: { n: doc("n", { externallyDeleted: true }) },
        tabbedDocIds: [],
        saveFailed: { n: true },
        remoteDeleted: ["Заметки/n.md"],
      }),
    )
    expect(decision).toEqual([])
  })

  it("has no copy for a card whose note is not open", () => {
    expect(deriveCentre(input({ saveFailed: { gone: true } })).decision).toEqual([])
  })

  it("has the same id as the card of the note, so that a decision in one place removes both", () => {
    expect(noteNoticeId("n", "save-failed")).toBe(noteNoticeId("n", "save-failed"))
    expect(noteNoticeId("n", "save-failed")).not.toBe(noteNoticeId("m", "save-failed"))
    expect(noteNoticeId("n", "save-failed")).not.toBe(noteNoticeId("n", "draft"))
    const before = deriveCentre(input({ openDocs: { n: doc("n") }, saveFailed: { n: true } }))
    const after = deriveCentre(input({ openDocs: { n: doc("n") }, saveFailed: {} }))
    expect(before.decision).toHaveLength(1)
    expect(after.decision).toHaveLength(0)
  })

  it("puts danger before decisions", () => {
    const { decision } = deriveCentre(
      input({
        conflicts: [conflict],
        openDocs: { n: doc("n") },
        saveFailed: { n: true },
      }),
    )
    expect(decision.map((entry) => entry.level)).toEqual(["danger", "decision"])
  })
})

describe("what asks for attention", () => {
  it("has the limits of the plan and the files that failed one by one", () => {
    const { warning, decision } = deriveCentre(
      input({
        limits: [{ kind: "tooLarge", count: 2, maxBytes: 1000 }, { kind: "quotaFull" }],
        itemErrors: 3,
      }),
    )
    expect(decision).toEqual([])
    expect(ids(warning)).toEqual(["limit:tooLarge", "limit:quotaFull", "item-errors"])
    expect(warning.every((entry) => entry.level === "warning")).toBe(true)
    expect(warning[0]).toMatchObject({ count: 2, maxBytes: 1000, action: { kind: "settings" } })
    expect(warning[2]).toMatchObject({ count: 3 })
  })

  it("leaves a hidden record out", () => {
    const { warning } = deriveCentre(
      input({ limits: [{ kind: "quotaFull" }], itemErrors: 1, hidden: ["limit:quotaFull"] }),
    )
    expect(ids(warning)).toEqual(["item-errors"])
  })

  it("never hides what needs a decision", () => {
    const { decision } = deriveCentre(
      input({ conflicts: [conflict], hidden: ["sync-conflict:0123456789ab"] }),
    )
    expect(decision).toHaveLength(1)
  })

  it("lets a hidden record come back only after its cause has gone and come again", () => {
    let hidden = ["limit:quotaFull"]
    // The cause is still there: the record stays hidden.
    hidden = reconcileHidden(hidden, ["limit:quotaFull", "item-errors"])
    expect(hidden).toEqual(["limit:quotaFull"])
    // The cause has gone: the hiding is forgotten...
    hidden = reconcileHidden(hidden, ["item-errors"])
    expect(hidden).toEqual([])
    // ...so when the cause comes again, the record is shown.
    expect(ids(deriveCentre(input({ limits: [{ kind: "quotaFull" }], hidden })).warning)).toEqual([
      "limit:quotaFull",
    ])
  })
})

describe("the number on the bell", () => {
  it("is nothing while nothing is wrong", () => {
    expect(centreCounter(deriveCentre(input()))).toBeNull()
  })

  it("counts the records of both sections and takes the level of the most serious", () => {
    expect(
      centreCounter(
        deriveCentre(input({ conflicts: [conflict], limits: [{ kind: "quotaFull" }] })),
      ),
    ).toEqual({ count: 2, level: "decision" })
    expect(centreCounter(deriveCentre(input({ limits: [{ kind: "quotaFull" }] })))).toEqual({
      count: 1,
      level: "warning",
    })
    expect(
      centreCounter(
        deriveCentre(
          input({
            conflicts: [conflict],
            openDocs: { n: doc("n") },
            saveFailed: { n: true },
            itemErrors: 1,
          }),
        ),
      ),
    ).toEqual({ count: 3, level: "danger" })
  })

  it("does not count a hidden record", () => {
    expect(
      centreCounter(deriveCentre(input({ itemErrors: 1, hidden: ["item-errors"] }))),
    ).toBeNull()
  })
})
