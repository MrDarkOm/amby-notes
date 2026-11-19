import { describe, expect, it } from "vitest"
import {
  docToMarkdown,
  editorSchema,
  markdownToDoc,
  roundTripCheck,
  restoreSourceFormatting,
} from "./markdown"

describe("callout Unicode icons", () => {
  it.each([
    "👍🏽",
    "👩🏽‍💻",
    "🇫🇮",
    "🇺🇦",
    "1️⃣",
    "🏳️‍🌈",
    "👨‍👩‍👧‍👦",
    "☀︎",
    "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  ])("keeps %s whole, including after editing the body", (emoji) => {
    const source = `> [!NOTE]+ ${emoji} Title\n> Body.\n`
    const doc = editorSchema.nodeFromJSON(markdownToDoc(source))
    expect(doc.firstChild?.attrs.emoji).toBe(emoji)
    expect(doc.firstChild?.firstChild?.textContent).toBe("Title\nBody.")
    expect(restoreSourceFormatting(docToMarkdown(doc), source)).toBe(source)
    expect(roundTripCheck(source).ok).toBe(true)

    const content = doc.toJSON()
    const callout = content.content![0]
    callout.content![0].content![0].text = "Title\nEdited body."
    const edited = docToMarkdown(editorSchema.nodeFromJSON(content))
    expect(edited).toContain(`> [!NOTE]+ ${emoji} Title`)
    expect(edited).toContain("Edited body.")
    expect(editorSchema.nodeFromJSON(markdownToDoc(edited)).firstChild?.attrs.emoji).toBe(emoji)
  })

  it("retains BOM and CRLF without editing or changing ordinary emoji text", () => {
    const source = "\uFEFF> [!TIP] 👩🏽‍💻 Title\r\n> Body 👍🏽.\r\n\r\nOrdinary 🇫🇮 text.\r\n"
    expect(
      restoreSourceFormatting(
        docToMarkdown(editorSchema.nodeFromJSON(markdownToDoc(source))),
        source,
      ),
    ).toBe(source)
  })
})
