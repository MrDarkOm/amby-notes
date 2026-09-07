import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const sourceRoot = path.resolve(process.cwd(), "src")
const sourceExtensions = new Set([".css", ".ts", ".tsx"])

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolutePath)
    return sourceExtensions.has(path.extname(entry.name)) ? [absolutePath] : []
  })
}

describe("Motion boundary", () => {
  it("keeps application animation orchestration out of CSS and Tailwind utilities", () => {
    const violations = sourceFiles(sourceRoot).flatMap((file) => {
      if (file.endsWith("motion-boundary.test.ts")) return []
      const source = fs.readFileSync(file, "utf8")
      const patterns = [
        /(?:^|[\s"'`])(?:[a-z-]+:)*animate-[\w-[\]]+/gm,
        /(?:^|[\s"'`])(?:[a-z-]+:)*transition-[\w-[\],]+(?=[\s"'`])/gm,
        ...(file.endsWith(".css")
          ? [/@keyframes\b/g, /\banimation(?:-[a-z-]+)?\s*:/g, /\btransition(?:-[a-z-]+)?\s*:/g]
          : []),
      ]

      return patterns.flatMap((pattern) =>
        [...source.matchAll(pattern)].map((match) => {
          const line = source.slice(0, match.index).split("\n").length
          return `${path.relative(sourceRoot, file)}:${line}: ${match[0].trim()}`
        }),
      )
    })

    expect(violations).toEqual([])
  })
})
