import ts from "typescript"
import { describe, expect, it } from "vitest"

const visibleAttributes = new Set(["alt", "aria-label", "placeholder", "title"])
const hasLetters = /[\p{L}]/u
const nonLinguisticLabels = /^(?:⌘[A-Z]|H)$/u

const componentSources = import.meta.glob("../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/**
 * Prevent regressions where visible JSX text bypasses the locale resources.
 * User-authored content and internal identifiers are expressions, so this guard
 * deliberately targets literal JSX nodes and user-facing string attributes.
 */
describe("localization boundary", () => {
  it("keeps literal UI words out of components", () => {
    const failures: string[] = []
    for (const [file, source] of Object.entries(componentSources)) {
      if (file.includes(".test.")) continue
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const inspect = (node: ts.Node) => {
        let literal: string | undefined
        if (ts.isJsxText(node)) literal = node.text.trim()
        if (
          ts.isJsxAttribute(node) &&
          visibleAttributes.has(node.name.getText(parsed)) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer)
        ) {
          literal = node.initializer.text.trim()
        }
        if (literal && hasLetters.test(literal) && !nonLinguisticLabels.test(literal)) {
          const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
          failures.push(`${file}:${line} ${JSON.stringify(literal)}`)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(parsed)
    }
    expect(failures).toEqual([])
  })
})
