// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { DocumentTitle } from "./document-title"

afterEach(() => {
  cleanup()
})

describe("DocumentTitle", () => {
  it("commits rename and calls onSubmit on Enter", async () => {
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
    await waitFor(() => expect(onEditingTitleChange).toHaveBeenCalledWith(false))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // Leaving the field after Enter must not rename a second time.
    fireEvent.blur(textarea)
    expect(onRenameTitle).toHaveBeenCalledTimes(1)
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

  describe("a refused name (docs/notices.md, section 8)", () => {
    const refusal = {
      status: "failed" as const,
      text: "Такое название уже занято. Введите другое.",
    }

    function setup() {
      const onRenameTitle = vi.fn(async () => refusal)
      const onEditingTitleChange = vi.fn()
      const onSubmit = vi.fn()
      const view = render(
        <DocumentTitle
          title="Plan"
          editingTitle={true}
          onEditingTitleChange={onEditingTitleChange}
          onRenameTitle={onRenameTitle}
          onSubmit={onSubmit}
        />,
      )
      const textarea = view.getByRole("textbox") as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: "Taken" } })
      fireEvent.keyDown(textarea, { key: "Enter" })
      return { ...view, textarea, onRenameTitle, onEditingTitleChange, onSubmit }
    }

    it("keeps the field open with the typed name and says why under it", async () => {
      const { findByTestId, textarea, onEditingTitleChange, onSubmit } = setup()
      expect((await findByTestId("rename-hint")).textContent).toContain(refusal.text)
      expect(textarea.value).toBe("Taken")
      expect(onEditingTitleChange).not.toHaveBeenCalledWith(false)
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it("takes the hint away when the name is edited", async () => {
      const { findByTestId, queryByTestId, textarea } = setup()
      await findByTestId("rename-hint")
      fireEvent.change(textarea, { target: { value: "Taken 2" } })
      expect(queryByTestId("rename-hint")).toBeNull()
    })

    it("restores the real title and drops the hint on Escape", async () => {
      const { findByTestId, queryByTestId, textarea, onEditingTitleChange } = setup()
      await findByTestId("rename-hint")
      fireEvent.keyDown(textarea, { key: "Escape" })
      expect(textarea.value).toBe("Plan")
      expect(queryByTestId("rename-hint")).toBeNull()
      expect(onEditingTitleChange).toHaveBeenCalledWith(false)
    })

    it("gives up, instead of asking again, when the field is left with the refused name", async () => {
      const { findByTestId, queryByTestId, textarea, onRenameTitle, onEditingTitleChange } = setup()
      await findByTestId("rename-hint")
      fireEvent.blur(textarea)
      expect(onRenameTitle).toHaveBeenCalledTimes(1)
      expect(onEditingTitleChange).toHaveBeenCalledWith(false)
      expect(textarea.value).toBe("Plan")
      expect(queryByTestId("rename-hint")).toBeNull()
    })
  })
})
