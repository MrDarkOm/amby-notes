// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { OptionCell } from "./option-cell"
import { OptionActionsProvider, type OptionActions } from "./option-actions"

const property = (propertyType: string): DatabasePropertySummary => ({
  propertyId: "p",
  name: "Stage",
  propertyType,
  configJson: "{}",
  options: [
    { optionId: "a", name: "Todo", color: "#94a3b8" },
    { optionId: "b", name: "Done", color: "#22c55e" },
  ],
})

describe("OptionCell", () => {
  afterEach(cleanup)

  it("shows the chosen option by name and commits a pick from the list", async () => {
    const onCommit = vi.fn(async () => {})
    render(
      <OptionCell
        property={property("status")}
        value={{ type: "status", optionId: "a" }}
        pending={false}
        onCommit={onCommit}
      />,
    )
    expect(screen.getByText("Todo")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Stage" }))
    fireEvent.click(await screen.findByRole("option", { name: /Done/ }))
    expect(onCommit).toHaveBeenCalledWith(JSON.stringify({ type: "status", optionId: "b" }))
  })

  it("toggles several options of a multi-select and clears the value", async () => {
    const onCommit = vi.fn(async () => {})
    render(
      <OptionCell
        property={property("multiSelect")}
        value={{ type: "multiSelect", optionIds: ["a"] }}
        pending={false}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Stage" }))
    fireEvent.click(await screen.findByRole("option", { name: /Done/ }))
    expect(onCommit).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "multiSelect", optionIds: ["a", "b"] }),
    )
    fireEvent.click(screen.getByRole("option", { name: /Todo/ }))
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
  })

  it("does not let a click on the control reach the card behind it", () => {
    const onCardClick = vi.fn()
    render(
      <div onClick={onCardClick}>
        <OptionCell
          property={property("select")}
          value={null}
          pending={false}
          onCommit={async () => {}}
        />
      </div>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Stage" }))
    expect(onCardClick).not.toHaveBeenCalled()
  })

  describe("creating options in place", () => {
    const withActions = (actions: OptionActions, onCommit: (value?: string) => Promise<void>) =>
      render(
        <OptionActionsProvider value={actions}>
          <OptionCell
            property={property("select")}
            value={null}
            pending={false}
            onCommit={onCommit}
          />
        </OptionActionsProvider>,
      )

    it("filters the list by the typed text", async () => {
      withActions({ createOption: async () => null, editOptions: () => {} }, async () => {})
      fireEvent.click(screen.getByRole("button", { name: "Stage" }))
      fireEvent.change(await screen.findByRole("textbox"), { target: { value: "do" } })
      expect(screen.queryByRole("option", { name: /Todo/ })).toBeTruthy()
      expect(screen.queryByRole("option", { name: /Done/ })).toBeTruthy()
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "don" } })
      expect(screen.queryByRole("option", { name: /Todo/ })).toBeNull()
    })

    it("creates the typed option and selects it", async () => {
      const createOption = vi.fn(async () => "new-id")
      const onCommit = vi.fn(async () => {})
      withActions({ createOption, editOptions: () => {} }, onCommit)
      fireEvent.click(screen.getByRole("button", { name: "Stage" }))
      const input = await screen.findByRole("textbox")
      fireEvent.change(input, { target: { value: "  Blocked " } })
      fireEvent.keyDown(input, { key: "Enter" })
      await vi.waitFor(() =>
        expect(onCommit).toHaveBeenCalledWith(
          JSON.stringify({ type: "select", optionId: "new-id" }),
        ),
      )
      expect(createOption).toHaveBeenCalledWith("p", "Blocked")
    })

    it("picks the existing option instead of creating a duplicate", async () => {
      const createOption = vi.fn(async () => "x")
      const onCommit = vi.fn(async () => {})
      withActions({ createOption, editOptions: () => {} }, onCommit)
      fireEvent.click(screen.getByRole("button", { name: "Stage" }))
      const input = await screen.findByRole("textbox")
      fireEvent.change(input, { target: { value: "done" } })
      expect(screen.queryByText(/Создать/)).toBeNull()
      fireEvent.keyDown(input, { key: "Enter" })
      expect(createOption).not.toHaveBeenCalled()
      expect(onCommit).toHaveBeenCalledWith(JSON.stringify({ type: "select", optionId: "b" }))
    })

    it("selects nothing when creating fails", async () => {
      const onCommit = vi.fn(async () => {})
      const createOption = vi.fn(async () => null)
      withActions({ createOption, editOptions: () => {} }, onCommit)
      fireEvent.click(screen.getByRole("button", { name: "Stage" }))
      const input = await screen.findByRole("textbox")
      fireEvent.change(input, { target: { value: "Blocked" } })
      fireEvent.click(screen.getByText(/Создать/))
      await vi.waitFor(() => expect(createOption).toHaveBeenCalled())
      expect(onCommit).not.toHaveBeenCalled()
    })

    it("opens the options editor from the list", async () => {
      const editOptions = vi.fn()
      withActions({ createOption: async () => null, editOptions }, async () => {})
      fireEvent.click(screen.getByRole("button", { name: "Stage" }))
      fireEvent.click(await screen.findByRole("button", { name: "Изменить варианты" }))
      expect(editOptions).toHaveBeenCalledWith("p")
    })

    it("offers no creation without actions", async () => {
      render(
        <OptionCell
          property={property("select")}
          value={null}
          pending={false}
          onCommit={async () => {}}
        />,
      )
      fireEvent.click(screen.getByRole("button", { name: "Stage" }))
      fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Zzz" } })
      expect(screen.queryByText(/Создать/)).toBeNull()
      expect(screen.queryByRole("button", { name: "Изменить варианты" })).toBeNull()
    })
  })
})
