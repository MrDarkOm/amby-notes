// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, render } from "@testing-library/react"
import { EditorView } from "@codemirror/view"
import { afterEach, expect, it, vi } from "vitest"
import { SourceEditor } from "./source-editor"
import { flushAutosaveGeneration } from "./autosave/autosave-lifecycle"
import type { EditorHandle } from "./tiptap/constants"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("publishes pending Source text during a global flush without blur", async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const editorRef = React.createRef<EditorHandle>() as React.RefObject<EditorHandle>
  const { container } = render(
    <SourceEditor value="original" onChange={onChange} editorRef={editorRef} />,
  )
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "latest unsaved source" },
    }),
  )
  expect(onChange).not.toHaveBeenCalled()

  await act(async () => {
    await flushAutosaveGeneration(71)
  })
  expect(onChange).toHaveBeenCalledWith("latest unsaved source")
})
