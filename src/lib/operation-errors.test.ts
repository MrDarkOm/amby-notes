import { afterEach, describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import type { FailureReason } from "@/lib/bindings"
import {
  DatabaseOperationError,
  FileRevisionConflictError,
  NoteRevisionConflictError,
  ProjectOperationError,
  StorageOperationError,
} from "@/lib/storage"
import { databaseFailure } from "@/lib/test-utils/errors"
import { KNOWN_DATABASE_FAILURE_REASONS } from "./database-errors"
import { operationErrorCode, operationErrorText } from "./operation-errors"

const t = i18n.t.bind(i18n)

/** Mirrors `FailureReason` in src-tauri/src/database/failure.rs. */
const REASONS: FailureReason[] = [
  "revision_conflict",
  "locked",
  "read_only",
  "not_found",
  "name_taken",
  "invalid_name",
  "values_not_empty",
  "has_dependents",
  "formula_invalid",
  "last_view",
  "invalid_config",
  "relation_invalid",
  "invalid_value",
  "too_large",
  "rolled_back",
  "recovery_required",
  "stale_cursor",
  "yaml_conflict",
  "io",
  "failed",
]

afterEach(async () => {
  await i18n.changeLanguage("ru")
})

describe("database failure reasons", () => {
  it("knows every reason the backend can send", () => {
    expect([...KNOWN_DATABASE_FAILURE_REASONS].sort()).toEqual([...REASONS].sort())
  })

  it("has a text in Russian and in English for each reason", async () => {
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language)
      const seen = new Map<string, string>()
      for (const reason of REASONS) {
        if (reason === "failed") continue
        const text = operationErrorText(databaseFailure(reason), t)
        expect(text, `${language} ${reason}`).not.toMatch(/^databaseErrors\./)
        expect(text.trim().length, `${language} ${reason}`).toBeGreaterThan(10)
        expect(seen.get(text), `${language} ${reason} repeats ${seen.get(text)}`).toBeUndefined()
        seen.set(text, reason)
      }
    }
  })

  it("never shows the backend sentence, a path or the internal code", () => {
    for (const reason of REASONS) {
      const text = operationErrorText(databaseFailure(reason), t)
      expect(text, reason).not.toContain("Raw Rust sentence")
      expect(text, reason).not.toContain("/Users/someone")
      expect(text, reason).not.toContain("A.md")
    }
  })

  it("says what happened, what happened to the data and what to do for a conflict", () => {
    const text = operationErrorText(databaseFailure("revision_conflict"), t)
    expect(text).toMatch(/изменилась/)
    expect(text).toMatch(/не записан|не потеряны|целы/)
    expect(text).toMatch(/повтор/i)
  })

  it("words a refusal because values exist by what was being changed", () => {
    const error = databaseFailure("values_not_empty")
    expect(operationErrorText(error, t, { change: "type" })).toMatch(/нет его значений/)
    expect(operationErrorText(error, t, { change: "relation" })).toMatch(/связанные страницы/)
    expect(operationErrorText(error, t, { change: "date" })).toMatch(/Хранение времени/)
  })

  it("answers an unclassified failure with the general text and the command code, small", () => {
    const error = databaseFailure("failed", "Something odd in /Users/x", "databaseRenameFailed")
    const text = operationErrorText(error, t)
    expect(text).toContain("databaseRenameFailed")
    expect(text).not.toContain("Something odd")
    expect(operationErrorCode(error)).toBe("databaseRenameFailed")
  })

  it("answers a reason from a newer backend like an unclassified failure", () => {
    const error = new DatabaseOperationError(
      "failed",
      "x",
      "databaseRenameFailed",
      "from_the_future" as FailureReason,
    )
    expect(operationErrorText(error, t)).toContain("databaseRenameFailed")
  })

  it("words the three kinds without a reason", () => {
    expect(operationErrorText(new DatabaseOperationError("moduleDisabled", "x"), t)).toMatch(
      /модуль/i,
    )
    expect(operationErrorText(new DatabaseOperationError("vaultNotOpen", "x"), t)).toMatch(
      /хранилище/i,
    )
    expect(
      operationErrorText(new DatabaseOperationError("vaultGenerationConflict", "x"), t),
    ).toMatch(/хранилище изменилось/i)
  })
})

describe("operationErrorCode", () => {
  it("is the reason for a classified database failure", () => {
    expect(operationErrorCode(databaseFailure("revision_conflict"))).toBe("revision_conflict")
  })

  it("is the kind of a project failure and the code of an unclassified one", () => {
    expect(
      operationErrorCode(
        new ProjectOperationError("pathCollision", "x", { kind: "pathCollision", path: "A" }),
      ),
    ).toBe("pathCollision")
    expect(
      operationErrorCode(
        new ProjectOperationError("failed", "x", {
          kind: "failed",
          code: "readManifest",
          message: "x",
        }),
      ),
    ).toBe("readManifest")
  })

  it("is revision_conflict for the revision errors of notes and files", () => {
    expect(operationErrorCode(new NoteRevisionConflictError("r"))).toBe("revision_conflict")
    expect(operationErrorCode(new FileRevisionConflictError("r"))).toBe("revision_conflict")
  })

  it("is the code of a storage error and unknown for anything else", () => {
    expect(operationErrorCode(new StorageOperationError("notFound", "x"))).toBe("notFound")
    expect(operationErrorCode(new Error("boom"))).toBe("unknown")
    expect(operationErrorCode("boom")).toBe("unknown")
  })
})

describe("operationErrorText for the other errors", () => {
  it("words a storage error by its code and never by its message", () => {
    const text = operationErrorText(
      new StorageOperationError("notFound", "No such file /Users/a/Vault/B.md"),
      t,
    )
    expect(text).not.toContain("B.md")
    expect(text).toMatch(/не найден/i)
  })

  it("words a revision error of a note as a conflict", () => {
    expect(operationErrorText(new NoteRevisionConflictError("r"), t)).toMatch(/изменил/)
  })

  it("shows the general text with the code unknown for a bare error", () => {
    const text = operationErrorText(new Error("TypeError: x is undefined at /src/a.ts"), t)
    expect(text).not.toContain("undefined")
    expect(text).toContain("unknown")
  })

  it("shows the general text for a thrown string", () => {
    expect(operationErrorText("disk exploded", t)).not.toContain("disk exploded")
  })
})
