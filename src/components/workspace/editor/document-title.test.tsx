// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { DocumentTitle } from "./document-title"

afterEach(() => {
  cleanup()
})

describe("DocumentTitle", () => {
  it("commits rename and calls onSubmit on Enter", () => {
    const onRenameTitle = vi.fn()
    const onEditingTitleChange = vi.fn()
    const onSubmit = vi.fn()

    const { getByRole } = render(
      <DocumentTitle
        title="My Note"
        editingTitle={true}
        onEditingTitleChange={onEditingTitleChange}
        onRenameTitle={onRenameTitle}
        onSubmit={onSubmit}
      />,
    )

    const textarea = getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Updated Note" } })
    fireEvent.keyDown(textarea, { key: "Enter" })

    expect(onRenameTitle).toHaveBeenCalledWith("Updated Note")
    expect(onEditingTitleChange).toHaveBeenCalledWith(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("reverts on Escape without triggering onSubmit", () => {
    const onRenameTitle = vi.fn()
    const onEditingTitleChange = vi.fn()
    const onSubmit = vi.fn()

    const { getByRole } = render(
      <DocumentTitle
        title="Original Title"
        editingTitle={true}
        onEditingTitleChange={onEditingTitleChange}
        onRenameTitle={onRenameTitle}
        onSubmit={onSubmit}
      />,
    )

    const textarea = getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Changed" } })
    fireEvent.keyDown(textarea, { key: "Escape" })

    expect(onRenameTitle).not.toHaveBeenCalled()
    expect(onEditingTitleChange).toHaveBeenCalledWith(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
