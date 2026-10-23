// @vitest-environment happy-dom
// The comparison of a sync conflict in Live mode (docs/sync-plan.md, stage Э4б, К4): the result is put
// together from the SOURCE TEXT of the blocks the person chose, the way Live Preview keeps a block's
// source, never written again from the drawing. Everything untouched stays byte for byte: BOM, line
// endings, markup the editor would spell differently. Behaviour only; the window is in the dialog test.
import { describe, expect, it } from "vitest"
import {
  assembleCompare,
  planBlockCompare,
  type BlockCompare,
  type CompareChoice,
  type ComparePlan,
} from "./block-compare"

function blocks(plan: ComparePlan): BlockCompare {
  if (plan.kind !== "blocks") throw new Error(`expected a block plan, got ${plan.reason}`)
  return plan
}

const choose = (plan: BlockCompare, ...choices: CompareChoice[]) => assembleCompare(plan, choices)
const all = (plan: BlockCompare, choice: CompareChoice) =>
  assembleCompare(
    plan,
    plan.hunks.map(() => choice),
  )

const MINE = "# Заголовок\n\nпервый абзац\n\nмой второй абзац\n\nпоследний абзац\n"
const OTHER = "# Заголовок\n\nпервый абзац\n\nих второй абзац\n\nпоследний абзац\n"

describe("finding the blocks that differ", () => {
  it("finds nothing when the two versions are the same", () => {
    const plan = blocks(planBlockCompare("n.md", MINE, MINE))
    expect(plan.hunks).toEqual([])
    expect(all(plan, "mine")).toBe(MINE)
  })

  it("marks one changed paragraph as one hunk with both texts", () => {
    const plan = blocks(planBlockCompare("n.md", MINE, OTHER))
    expect(plan.hunks).toHaveLength(1)
    expect(plan.hunks[0]).toMatchObject({
      kind: "blocks",
      mine: ["мой второй абзац"],
      other: ["их второй абзац"],
    })
  })

  it("is for notes only: a file that is not Markdown is chosen as a whole", () => {
    expect(planBlockCompare("data.json", "{}", "{ }")).toMatchObject({
      kind: "whole",
      reason: "not-markdown",
    })
    expect(planBlockCompare("n.md", null, "text")).toMatchObject({
      kind: "whole",
      reason: "not-text",
    })
    expect(planBlockCompare("n.md", "text", null)).toMatchObject({
      kind: "whole",
      reason: "not-text",
    })
  })

  it("is chosen as a whole when a version mixes line endings or has an unterminated envelope", () => {
    expect(planBlockCompare("n.md", "a\r\nb\nc\n", "a\nb\nc\n")).toMatchObject({
      kind: "whole",
      reason: "line-endings",
    })
    expect(planBlockCompare("n.md", "---\ntitle: x\n\nbody\n", "body\n")).toMatchObject({
      kind: "whole",
      reason: "frontmatter",
    })
  })

  it("opens in the source view when a version does not pass the admission of Live Preview", () => {
    const refused = "[label][ref]\n\npara\n\n[ref]: https://example.com\n"
    const plan = blocks(
      planBlockCompare("n.md", refused, "[label][ref]\n\nother\n\n[ref]: https://example.com\n"),
    )
    expect(plan.live).toBe(false)
    expect(blocks(planBlockCompare("n.md", MINE, OTHER)).live).toBe(true)
    // the choice still works on the source of the blocks
    expect(all(plan, "mine")).toBe(refused)
  })
})

describe("putting the result together from the chosen blocks", () => {
  it("“mine” for every difference gives my file byte for byte, “theirs” gives theirs", () => {
    const plan = blocks(planBlockCompare("n.md", MINE, OTHER))
    expect(choose(plan, "mine")).toBe(MINE)
    expect(choose(plan, "other")).toBe(OTHER)
  })

  it("“both” keeps my block, then theirs, and nothing else changes", () => {
    const plan = blocks(planBlockCompare("n.md", MINE, OTHER))
    expect(choose(plan, "both")).toBe(
      "# Заголовок\n\nпервый абзац\n\nмой второй абзац\n\nих второй абзац\n\nпоследний абзац\n",
    )
  })

  it("chooses every difference on its own", () => {
    const mine = "один\n\nдва мой\n\nтри\n\nчетыре мой\n"
    const other = "один\n\nдва их\n\nтри\n\nчетыре их\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(2)
    expect(choose(plan, "other", "mine")).toBe("один\n\nдва их\n\nтри\n\nчетыре мой\n")
    expect(choose(plan, "mine", "other")).toBe("один\n\nдва мой\n\nтри\n\nчетыре их\n")
    expect(choose(plan, "both", "other")).toBe("один\n\nдва мой\n\nдва их\n\nтри\n\nчетыре их\n")
  })

  it("handles a block only the other version has, and one only mine has", () => {
    const mine = "один\n\nтолько у меня\n\nдва\n"
    const other = "один\n\nдва\n\nтолько у них\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(2)
    expect(all(plan, "mine")).toBe(mine)
    expect(all(plan, "other")).toBe(other)
    expect(all(plan, "both")).toBe("один\n\nтолько у меня\n\nдва\n\nтолько у них\n")
  })

  it("compares headings and code blocks as blocks", () => {
    const mine = "# Мой заголовок\n\n```ts\nconst a = 1\n```\n\nконец\n"
    const other = "# Их заголовок\n\n```ts\nconst a = 2\n```\n\nконец\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(2)
    expect(plan.hunks[0]?.mine).toEqual(["# Мой заголовок"])
    expect(plan.hunks[1]?.other).toEqual(["```ts\nconst a = 2\n```"])
    expect(choose(plan, "other", "mine")).toBe(
      "# Их заголовок\n\n```ts\nconst a = 1\n```\n\nконец\n",
    )
  })

  it("compares the items of a list one by one and keeps the bullets as written", () => {
    const mine = "* яблоки\n* мои груши\n* сливы\n"
    const other = "* яблоки\n* их груши\n* сливы\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(1)
    expect(plan.hunks[0]?.mine).toEqual(["* мои груши"])
    expect(choose(plan, "other")).toBe(other)
    expect(choose(plan, "mine")).toBe(mine)
    expect(choose(plan, "both")).toBe("* яблоки\n* мои груши\n* их груши\n* сливы\n")
  })
})

describe("the bytes nobody touched stay as they were", () => {
  // markup the editor would spell differently: a setext heading, `*` bullets, a spaced rule,
  // trailing spaces, a tilde fence, extra blank lines
  const odd = [
    "Название\n========",
    "* пункт один\n* пункт два",
    "* * *",
    "строка с хвостом  \nвторая строка",
    "~~~\nкод   с   пробелами\n~~~",
  ]
  const make = (middle: string, eol: string, bom = "") =>
    `${bom}${[odd[0], odd[1], middle, odd[2], odd[3], odd[4]].join("\n\n\n")}\n`.replaceAll(
      "\n",
      eol,
    )

  it("keeps a BOM and CRLF in every block that was not chosen from the other version", () => {
    const mine = make("мой абзац", "\r\n", "﻿")
    const other = make("их абзац", "\r\n", "﻿")
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(1)
    expect(choose(plan, "mine")).toBe(mine)
    expect(choose(plan, "other")).toBe(other)
    const both = choose(plan, "both")
    expect(both.startsWith("﻿")).toBe(true)
    expect(both).not.toMatch(/(^|[^\r])\n/u)
    for (const block of odd) expect(both).toContain(block.replaceAll("\n", "\r\n"))
  })

  it("writes a block taken from a file with other line endings in the endings of my file", () => {
    const mine = make("мой абзац", "\r\n")
    const other = make("их\nабзац", "\n")
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(1)
    const result = choose(plan, "other")
    expect(result).not.toMatch(/(^|[^\r])\n/u)
    expect(result).toContain("их\r\nабзац")
    // and back: a file with LF takes a block from a CRLF file in LF
    const reverse = blocks(planBlockCompare("n.md", other, mine))
    expect(assembleCompare(reverse, ["other"])).not.toContain("\r")
  })

  it("keeps my BOM and does not take one from the other version", () => {
    const withBom = blocks(planBlockCompare("n.md", "﻿a\n\nмой\n", "a\n\nих\n"))
    expect(choose(withBom, "other")).toBe("﻿a\n\nих\n")
    const without = blocks(planBlockCompare("n.md", "a\n\nмой\n", "﻿a\n\nих\n"))
    expect(choose(without, "other")).toBe("a\n\nих\n")
  })

  it("keeps the blank lines between blocks, the end of the file and the lack of one", () => {
    const mine = "\n\nа\n\n\n\nб мой\n\nв"
    const other = "\n\nа\n\n\n\nб их\n\nв"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(all(plan, "mine")).toBe(mine)
    expect(all(plan, "other")).toBe(other)
  })

  it("keeps the properties envelope of my file when only the text differs", () => {
    const mine = "---\ntags: [a]\namby-id: 01HX\n---\n\nмой\n"
    const other = "---\ntags: [a]\namby-id: 01HX\n---\n\nих\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks.map((hunk) => hunk.kind)).toEqual(["blocks"])
    expect(all(plan, "other")).toBe(other)
    expect(all(plan, "mine")).toBe(mine)
  })
})

describe("the properties of a note", () => {
  it("are a difference of their own, taken whole from one side", () => {
    const mine = "---\ntags: [a]\namby-id: 01HX\n---\n\nтекст\n"
    const other = "---\ntags: [a, b]\namby-id: 01HX\n---\n\nтекст\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks).toHaveLength(1)
    expect(plan.hunks[0]).toMatchObject({ kind: "properties" })
    expect(plan.hunks[0]?.bothAllowed).toBe(false)
    expect(choose(plan, "other")).toBe(other)
    expect(choose(plan, "mine")).toBe(mine)
    // “both” cannot give two envelopes: it keeps mine
    expect(choose(plan, "both")).toBe(mine)
  })

  it("never change the identity of the note: a different amby-id is kept as mine", () => {
    const mine = "---\namby-id: 01AAAAAAAAAAAAAAAAAAAAAAAA\n---\n\nтекст\n"
    const other = "---\namby-id: 01BBBBBBBBBBBBBBBBBBBBBBBB\n---\n\nтекст\n"
    const plan = blocks(planBlockCompare("n.md", mine, other))
    expect(plan.hunks[0]?.locked).toBe(true)
    expect(choose(plan, "other")).toBe(mine)
  })
})
