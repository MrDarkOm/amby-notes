import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { ProjectOperationError } from "@/lib/storage"
import type { ProjectError } from "@/lib/bindings"
import { projectErrorText } from "./project-errors"

const t = i18n.t.bind(i18n)

function failure(payload: ProjectError): ProjectOperationError {
  return new ProjectOperationError(payload.kind, "Raw sentence /Users/x/Vault/Story", payload)
}

describe("projectErrorText", () => {
  it("does not show what the backend said when an operation was rolled back", () => {
    const text = projectErrorText(
      t,
      failure({ kind: "rolledBack", operationId: "o", message: "disk full at /Users/x" }),
    )
    expect(text).not.toContain("disk full")
    expect(text).not.toContain("/Users")
    expect(text).toMatch(/отмен/i)
  })

  it("does not show what the backend said when recovery is required", () => {
    const text = projectErrorText(
      t,
      failure({ kind: "recoveryRequired", operationId: "o", message: "journal 01J at /Users/x" }),
    )
    expect(text).not.toContain("journal")
    expect(text).not.toContain("/Users")
    expect(text).toMatch(/повторите|закройте/i)
  })

  it("names an existing item by its name, not by its path", () => {
    const text = projectErrorText(
      t,
      failure({ kind: "pathCollision", path: "/Users/x/Vault/Мастерские/Сага" }),
    )
    expect(text).toContain("Сага")
    expect(text).not.toContain("/Users")
    expect(text).not.toContain("Мастерские")
  })

  it("words a level in use without a raw sentence", () => {
    const text = projectErrorText(t, failure({ kind: "levelInUse", levelId: "L1", count: 3 }))
    expect(text).toMatch(/3/)
    expect(text).not.toContain("Level in use")
  })

  it("words a name refusal with a known reason and answers an unknown reason in general", () => {
    expect(
      projectErrorText(t, failure({ kind: "invalidName", field: "name", reason: "empty" })),
    ).toMatch(/Введите название/)
    const text = projectErrorText(
      t,
      failure({ kind: "invalidName", field: "name", reason: "the moon is in the wrong phase" }),
    )
    expect(text).not.toContain("moon")
    expect(text).toMatch(/название/i)
  })

  it("words the failed codes a person can act on", () => {
    expect(
      projectErrorText(t, failure({ kind: "failed", code: "folderNotEmpty", message: "x" })),
    ).toMatch(/не пуста/)
    expect(
      projectErrorText(t, failure({ kind: "failed", code: "sectionAlreadyExists", message: "x" })),
    ).toMatch(/уже есть/)
    expect(
      projectErrorText(t, failure({ kind: "failed", code: "interrupted", message: "x" })),
    ).toMatch(/прерван/i)
    expect(
      projectErrorText(t, failure({ kind: "failed", code: "readManifest", message: "x" })),
    ).toMatch(/повреждён|не читается/i)
  })

  it("answers any other failed code in general with the code, small", () => {
    const text = projectErrorText(
      t,
      failure({ kind: "failed", code: "projectIndexFailed", message: "SQL: no such table x" }),
    )
    expect(text).toContain("projectIndexFailed")
    expect(text).not.toContain("SQL")
  })

  it("answers the kinds without their own text in general and never with the raw sentence", () => {
    for (const payload of [
      { kind: "unsupportedRole", role: "weird" },
      { kind: "invalidOperationId" },
      { kind: "operationIdReused", operationId: "o" },
    ] satisfies ProjectError[]) {
      const text = projectErrorText(t, failure(payload))
      expect(text, payload.kind).toContain(payload.kind)
      expect(text, payload.kind).not.toContain("Raw sentence")
    }
  })

  it("answers anything that is not a project error in general", () => {
    const text = projectErrorText(t, new Error("TypeError: cannot read x"))
    expect(text).not.toContain("TypeError")
  })
})
