// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import type { DocumentProperties } from "../panel-registry"
import { InfoPanel } from "./info-panel"

afterEach(() => {
  cleanup()
})

const mockDocumentWithFrontmatter: DocumentProperties = {
  kind: "document",
  type: "Markdown",
  backlinks: 0,
  created: "2026-09-14",
  modified: "2026-09-14",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  frontmatter: {
    hasFrontmatter: true,
    customProperties: [],
    properties: [
      { key: "amby-id", value: "01ARZ3NDEKTSV4RRFFQ69G5FAV", valueKind: "text" },
      { key: "id", value: "legacy-id-123", valueKind: "text" },
      { key: "status", value: "in-progress", valueKind: "text" },
      { key: "priority", value: "1", valueKind: "number" },
      { key: "completed", value: "true", valueKind: "checkbox" },
      { key: "tags", value: "- books\n- design", valueKind: "list" },
    ],
  },
}

describe("InfoPanel frontmatter properties", () => {
  it("renders frontmatter properties excluding amby-id and id", () => {
    const { container } = render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={mockDocumentWithFrontmatter}
      />,
    )

    // Identity keys amby-id and id must not be in the properties section list
    const propertyList = container.querySelector('[role="list"]')
    expect(propertyList).not.toBeNull()
    const propertyItems = propertyList?.querySelectorAll('[role="listitem"]') ?? []
    expect(propertyItems.length).toBe(4) // status, priority, completed, tags

    // Verify key names are rendered
    expect(screen.getByText("status")).not.toBeNull()
    expect(screen.getByText("priority")).not.toBeNull()
    expect(screen.getByText("completed")).not.toBeNull()
    expect(screen.getByText("tags")).not.toBeNull()

    // Verify values
    expect(screen.getByText("in-progress")).not.toBeNull()
    expect(screen.getByDisplayValue("1")).not.toBeNull()
    expect(screen.getByText("books")).not.toBeNull()
    expect(screen.getByText("design")).not.toBeNull()

    // Verify checkbox is rendered for boolean
    const checkbox = container.querySelector('[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox?.getAttribute("aria-checked")).toBe("true")

    // Verify counter badge shows 4
    const counter = container.querySelector(".tabular-nums")
    expect(counter?.textContent).toBe("4")
  })

  it("renders empty state message when no properties are present", () => {
    const emptyDoc: DocumentProperties = {
      kind: "document",
      type: "Markdown",
      backlinks: 0,
      created: "2026-09-14",
      modified: "2026-09-14",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      frontmatter: {
        hasFrontmatter: true,
        customProperties: [],
        properties: [{ key: "amby-id", value: "01ARZ3NDEKTSV4RRFFQ69G5FAV", valueKind: "text" }],
      },
    }

    const { container } = render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={emptyDoc}
      />,
    )

    const counter = container.querySelector(".tabular-nums")
    expect(counter?.textContent).toBe("0")
  })

  it("toggles boolean frontmatter property on click", () => {
    const onUpsert = vi.fn()
    const { container } = render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={mockDocumentWithFrontmatter}
        onUpsertCustomProperty={onUpsert}
      />,
    )

    const checkbox = container.querySelector('[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox?.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(checkbox!)

    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "completed",
        name: "completed",
        propertyType: "checkbox",
        value: "false",
      }),
    )
  })

  it("calls onDeleteCustomProperty when delete button in property context menu is clicked", () => {
    const onDelete = vi.fn()
    render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={mockDocumentWithFrontmatter}
        onDeleteCustomProperty={onDelete}
      />,
    )

    const statusTrigger = screen.getByTitle("status")
    fireEvent.click(statusTrigger)

    const deleteButton = screen.getByTitle("Удалить свойство")
    expect(deleteButton).not.toBeNull()

    fireEvent.click(deleteButton)

    expect(onDelete).toHaveBeenCalledWith("status")
  })

  it("renders custom icon for frontmatter property and allows opening icon picker via property menu", () => {
    const docWithCustomIcon: DocumentProperties = {
      ...mockDocumentWithFrontmatter,
      frontmatter: {
        ...mockDocumentWithFrontmatter.frontmatter,
        customProperties: [
          {
            id: "priority",
            name: "priority",
            icon: "🔥",
            propertyType: "number",
            value: "1",
            settings: "",
          },
        ],
      },
    }

    const onUpsert = vi.fn()
    render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={docWithCustomIcon}
        onUpsertCustomProperty={onUpsert}
      />,
    )

    // Verify custom emoji is displayed for priority
    expect(screen.getByText("🔥")).not.toBeNull()

    const priorityTrigger = screen.getByTitle("priority")
    fireEvent.click(priorityTrigger)

    const iconButton = screen.getByTitle("Иконка свойства")
    expect(iconButton).not.toBeNull()

    fireEvent.click(iconButton)
    expect(document.body.querySelector(".amby-emoji-picker-panel") || document.body).not.toBeNull()

    const removeIconButton = screen.getByLabelText("Удалить иконку")
    fireEvent.click(removeIconButton)

    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "priority",
        name: "priority",
        icon: "",
      }),
    )
  })

  it("allows renaming a frontmatter property from the property context menu", () => {
    const onUpsert = vi.fn()
    render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={mockDocumentWithFrontmatter}
        onUpsertCustomProperty={onUpsert}
      />,
    )

    const statusTrigger = screen.getByTitle("status")
    fireEvent.click(statusTrigger)

    const nameInput = screen.getByLabelText("Название свойства")
    fireEvent.change(nameInput, { target: { value: "workflow_status" } })
    fireEvent.keyDown(nameInput, { key: "Enter" })

    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "workflow_status",
      }),
    )
  })

  it("allows changing property type and configuring options for select type", () => {
    const onUpsert = vi.fn()
    render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={mockDocumentWithFrontmatter}
        onUpsertCustomProperty={onUpsert}
      />,
    )

    const statusTrigger = screen.getByTitle("status")
    fireEvent.click(statusTrigger)

    const typeSelect = screen.getByDisplayValue("Текст")
    expect(typeSelect).not.toBeNull()

    // Change to select
    fireEvent.change(typeSelect, { target: { value: "select" } })

    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyType: "select",
      }),
    )

    // Options input should appear
    const optionsInput = screen.getByPlaceholderText("Например: Идея, В работе, Готово")
    expect(optionsInput).not.toBeNull()

    fireEvent.change(optionsInput, { target: { value: "Todo, Doing, Done" } })
    fireEvent.blur(optionsInput)

    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: "Todo, Doing, Done",
      }),
    )
  })

  it("renders dropdown select input for select property type with options", () => {
    const docWithSelect: DocumentProperties = {
      ...mockDocumentWithFrontmatter,
      frontmatter: {
        ...mockDocumentWithFrontmatter.frontmatter,
        customProperties: [
          {
            id: "status",
            name: "status",
            icon: "◆",
            propertyType: "select",
            value: "in-progress",
            settings: "todo, in-progress, done",
          },
        ],
      },
    }

    const onUpsert = vi.fn()
    render(
      <InfoPanel
        treeItems={[]}
        selectedId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        vault="/test-vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        properties={docWithSelect}
        onUpsertCustomProperty={onUpsert}
      />,
    )

    const select = screen.getByDisplayValue("in-progress")
    expect(select.tagName.toLowerCase()).toBe("select")

    fireEvent.change(select, { target: { value: "done" } })
    expect(onUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "done",
      }),
    )
  })
})
