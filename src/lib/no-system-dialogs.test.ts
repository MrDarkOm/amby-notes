// The windows of the system are not used (docs/notices.md, sections 9 and 13): a question is `confirm()`,
// a message goes to the place of its level. This guard fails on the old calls and on the permissions of the
// system message windows, so they cannot come back. A system file or folder picker stays (`dialog:allow-open`).
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/u.test(name) && !/\.test\.(ts|tsx)$/u.test(name) ? [path] : []
  })
}

// Written in parts so that this file is not its own finding.
const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ["window." + "confirm", /\bwindow\s*\.\s*confirm\b/u],
  ["window." + "alert", /\bwindow\s*\.\s*alert\b/u],
  ["globalThis." + "confirm", /\bglobalThis\s*\.\s*(confirm|alert)\b/u],
  ["confirm" + "Action", /\bconfirm(Action)\b/u],
  ["show" + "ErrorMessage", /\bshow(ErrorMessage)\b/u],
  ["plugin:dialog|" + "message", /plugin:dialog\|(message|ask|confirm)/u],
]

describe("no window of the system", () => {
  const files = sourceFiles(join(root, "src"))

  it.each(FORBIDDEN)("%s is not used in the code of the application", (label, pattern) => {
    const found = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
    expect(found, label).toEqual([])
  })

  it("does not ask the system for permission to show message windows", () => {
    for (const name of ["default.json", "settings-window.json"]) {
      const capability = readFileSync(join(root, "src-tauri", "capabilities", name), "utf8")
      expect(capability).not.toContain("dialog:allow-message")
      expect(capability).not.toContain("dialog:allow-ask")
      expect(capability).not.toContain("dialog:allow-confirm")
      // The pickers of a file and a folder are the exception (section 9).
      expect(capability).toContain("dialog:allow-open")
      expect(capability).toContain("dialog:allow-save")
    }
  })
})
