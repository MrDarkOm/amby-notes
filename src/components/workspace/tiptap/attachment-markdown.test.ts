// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"

import { docToNormalizedMarkdown, editorSchema, markdownToDoc, roundTripCheck } from "./markdown"
import { markdownMeaning } from "./markdown-meaning"

const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))

function nodes(markdown: string, type: string) {
  const found: Array<Record<string, unknown>> = []
  parse(markdown).descendants((node) => {
    if (node.type.name === type) found.push(node.attrs)
  })
  return found
}

describe("attachments in Markdown", () => {
  // The spellings an audio, video or PDF file is written with, by Amby and by Obsidian.
  it.each([
    "![song.mp3](assets/song.mp3)",
    "![clip.mp4](assets/clip.mp4)\n",
    "![report.pdf](assets/report.pdf)\n\nText after.\n",
    "![clip.mp4|480](assets/clip.mp4)",
    "![clip.mp4|480x270](assets/clip.mp4)",
    '![song](assets/song.mp3 "Live, 1999")',
    "Listen: ![song.mp3](assets/song.mp3) now.\n",
    "- ![song.mp3](assets/song.mp3)\n- ![report.pdf](assets/report.pdf)\n",
    "![tool.pdf.command](assets/tool.pdf.command)",
    "![archive.zip](assets/archive.zip)",
    "![[report.pdf]]",
    "![[song.mp3]]\n",
    "![[report.pdf#page=3]]",
    "![[clip.mp4|my clip]]",
    "Text\n\n![[assets/clip.mp4]]\n\nMore\n",
  ])("opens %j in Live and saves it without an edit as the same bytes", (markdown) => {
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it("reads a rewritten attachment back as the same thing, for the editor and for the second reader", () => {
    for (const markdown of [
      "![song.mp3](assets/song.mp3)",
      "![clip.mp4|480x270](assets/clip.mp4)",
      '![song](assets/song.mp3 "Live, 1999")',
      "![[report.pdf#page=3]]",
    ]) {
      const written = docToNormalizedMarkdown(parse(markdown))
      expect(nodes(written, "image")).toEqual(nodes(markdown, "image"))
      expect(nodes(written, "transclusion")).toEqual(nodes(markdown, "transclusion"))
      expect(markdownMeaning(written).content).toBe(markdownMeaning(markdown).content)
    }
  })

  it("keeps the file address, the name and the size of an attached file as image attributes", () => {
    expect(nodes("![clip.mp4|480x270](assets/clip.mp4)", "image")).toMatchObject([
      { src: "assets/clip.mp4", alt: "clip.mp4", width: 480, height: 270 },
    ])
  })

  it("reads an Obsidian embed of a file as an embed, keeping everything after the name", () => {
    expect(nodes("![[report.pdf#page=3]]", "transclusion")).toMatchObject([
      { target: "report.pdf", raw: "report.pdf#page=3" },
    ])
    expect(nodes("![[clip.mp4|my clip]]", "transclusion")).toMatchObject([
      { target: "clip.mp4", raw: "clip.mp4|my clip" },
    ])
  })

  it("never turns an attachment written as a plain link into a player", () => {
    const markdown = "[report.pdf](assets/report.pdf)\n"
    expect(nodes(markdown, "image")).toEqual([])
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it("keeps HTML media tags as inert source text", () => {
    const markdown = '<video src="assets/clip.mp4" controls></video>\n\n<iframe src="x"></iframe>\n'
    expect(nodes(markdown, "image")).toEqual([])
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
  })

  it("does not lose an address with a space written in angle brackets", () => {
    const markdown = "![my song.mp3](<assets/my song.mp3>)\n"
    const check = roundTripCheck(markdown)
    // Either the note opens and writes the same bytes, or it stays in Source: never a
    // changed address.
    if (check.ok) expect(check.result).toBe(markdown)
    else expect(check.refusal).toBeDefined()
  })
})
