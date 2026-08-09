import ts from "typescript"
import { describe, expect, it } from "vitest"

const colorLiteral = /(?:#[0-9a-f]{3,8}\b|rgba?\s*\(|hsla?\s*\()/iu

const componentSources = import.meta.glob("../components/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/** Static palette values belong in src/themes, never inside a component. */
describe("theme boundary", () => {
  it("keeps static color literals out of components", () => {
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
        const literal =
          ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
        if (literal && colorLiteral.test(literal)) {
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
