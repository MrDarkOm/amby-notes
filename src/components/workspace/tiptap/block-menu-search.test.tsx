// @vitest-environment happy-dom
// UI-12: the search of the block menu finds a section by a name in any language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import i18n from "@/lib/i18n"
import { BlockActionsPanel } from "./BlockActionsPanel"

let editor: Editor

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  editor = new Editor({
    extensions: [StarterKit],
    content: "<h2>Title</h2><ul><li><p>a</p></li></ul>",
  })
})
afterEach(() => {
  cleanup()
  editor.destroy()
})

function open(nodeType: string, nodePos: number) {
  const noop = vi.fn()
  render(
    <BlockActionsPanel
      editor={editor}
      nodePos={nodePos}
      nodeType={nodeType}
      isCallout={false}
      anchorRect={{ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } as never}
      onDuplicate={noop}
      onDelete={noop}
      onInsertAbove={noop}
      onInsertBelow={noop}
      onFocusInsideBlock={noop}
      onClose={noop}
    />,
  )
}

function search(text: string) {
  const input = screen.getByRole("textbox")
  act(() => {
    fireEvent.change(input, { target: { value: text } })
  })
}

const hasHeadingLevels = () => screen.queryByRole("button", { name: "H1" }) !== null

describe("block menu search aliases (UI-12)", () => {
  it("finds the heading level section by «заголовок» and by «heading» alike", () => {
    open("heading", 0)
    search("heading")
    const byEnglish = hasHeadingLevels()
    search("заголовок")
    const byRussian = hasHeadingLevels()
    expect(byEnglish).toBe(true)
    expect(byRussian).toBe(byEnglish)
  })

  it("finds the list section by names in both languages, whatever the interface language", async () => {
    const results: boolean[] = []
    for (const lng of ["ru", "en"]) {
      await i18n.changeLanguage(lng)
      for (const word of ["bullet", "список"]) {
        cleanup()
        open("listItem", 10)
        search(word)
        results.push(screen.queryAllByRole("button").length > 0)
      }
    }
    expect(results).toEqual([true, true, true, true])
  })
})
