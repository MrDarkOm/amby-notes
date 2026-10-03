import { describe, expect, it } from "vitest"

const sources = import.meta.glob("../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/** Drop-down lists are the app's own `AmbySelect`, never the system's native one. */
describe("select boundary", () => {
  it("keeps native <select> elements out of components", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.includes(".test."))
      .filter(([, source]) => /<select[\s>]/.test(source))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
