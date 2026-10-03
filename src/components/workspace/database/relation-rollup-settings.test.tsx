// @vitest-environment happy-dom
import { chooseOption, selectedText } from "@/lib/test-utils/amby-select"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary, DatabaseSummary } from "@/lib/storage"
import type { RelationConfigState } from "./property-settings"
import { RelationSettings } from "./relation-settings"
import type { RollupDraft } from "./rollup-model"
import { RollupSettings } from "./rollup-settings"

const hours: DatabasePropertySummary = {
  propertyId: "h",
  name: "Hours",
  propertyType: "number",
  configJson: "{}",
  options: [],
}
const databases = [
  { databaseId: "tasks", title: "Tasks", properties: [] },
  { databaseId: "projects", title: "Projects", properties: [hours] },
] as unknown as DatabaseSummary[]

const relation = (config: Record<string, unknown>): DatabasePropertySummary => ({
  propertyId: "r",
  name: "Project",
  propertyType: "relation",
  configJson: JSON.stringify({ targetDatabaseId: "projects", maxItems: null, ...config }),
  options: [],
})

describe("RelationSettings", () => {
  afterEach(cleanup)

  const mount = (
    config: Record<string, unknown> = {},
    onSave: (
      property: DatabasePropertySummary,
      state: RelationConfigState,
    ) => Promise<void> = vi.fn(async () => {}),
    linked = false,
  ) => {
    render(
      <RelationSettings
        property={relation(config)}
        databases={databases}
        currentDatabaseId="tasks"
        currentDatabaseTitle="Tasks"
        linked={linked}
        onSave={onSave}
      />,
    )
    return onSave as ReturnType<typeof vi.fn>
  }

  it("shows the database and the limit in two lists and the reverse links as a switch", () => {
    mount({ maxItems: 1, inversePropertyId: "back" })
    expect(selectedText("Связь с")).toBe("Projects")
    expect(selectedText("Ограничение")).toBe("1 страница")
    expect(
      screen.getByRole("switch", { name: "Двусторонняя связь" }).getAttribute("aria-checked"),
    ).toBe("true")
  })

  it("lists every database, marking this one, with the current one first", async () => {
    mount()
    fireEvent.click(screen.getByRole("combobox", { name: "Связь с" }))
    const labels = (await screen.findAllByRole("option")).map((option) => option.textContent)
    // The active choice (Projects) leads the list; this database is marked.
    expect(labels).toEqual(["Projects", "Tasks (эта база)"])
  })

  it("applies a chosen database at once, keeping the other settings", async () => {
    const onSave = mount({ maxItems: 1 })
    await chooseOption("Связь с", /Tasks/)
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toEqual({
      targetDatabaseId: "tasks",
      maxItems: 1,
      twoWay: false,
      inversePropertyName: "",
    })
  })

  it("applies the limit at once", async () => {
    const onSave = mount()
    await chooseOption("Ограничение", "1 страница")
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toMatchObject({ maxItems: 1, targetDatabaseId: "projects" })
  })

  it("turns the reverse property on and off with the switch, named after this database", async () => {
    const onSave = mount()
    fireEvent.click(screen.getByRole("switch", { name: "Двусторонняя связь" }))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toMatchObject({ twoWay: true, inversePropertyName: "Tasks" })
    cleanup()
    const off = mount({ inversePropertyId: "back" })
    fireEvent.click(screen.getByRole("switch", { name: "Двусторонняя связь" }))
    await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(1))
    expect(off.mock.calls[0][1]).toMatchObject({ twoWay: false, inversePropertyName: "" })
  })

  it("greys out the database and the reverse links once records have links, but not the limit", async () => {
    const onSave = mount({}, undefined, true)
    expect((screen.getByRole("combobox", { name: "Связь с" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole("switch", { name: "Двусторонняя связь" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    // The limit stays free to change, without a hint or a warning.
    await chooseOption("Ограничение", "1 страница")
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toMatchObject({ maxItems: 1 })
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows why a change was refused", async () => {
    mount({}, async () => {
      throw new Error("Relation values must be cleared first")
    })
    await chooseOption("Ограничение", "1 страница")
    expect((await screen.findByRole("alert")).textContent).toContain("cleared first")
  })
})

describe("RollupSettings", () => {
  afterEach(cleanup)

  const rollup: DatabasePropertySummary = {
    propertyId: "u",
    name: "Total",
    propertyType: "rollup",
    configJson: "{}",
    options: [],
  }
  const owner = {
    databaseId: "tasks",
    title: "Tasks",
    properties: [relation({}), rollup],
  } as unknown as DatabaseSummary

  it("explains that a relation is needed first", () => {
    render(
      <RollupSettings
        property={rollup}
        database={{ ...owner, properties: [rollup] } as DatabaseSummary}
        databases={databases}
        currentDatabaseId="tasks"
        onSave={async () => {}}
      />,
    )
    expect(screen.getByText(/связ/i)).toBeTruthy()
  })

  it("applies once the relation, the field and the function are all chosen", async () => {
    const onSave = vi.fn(async (_property: DatabasePropertySummary, _draft: RollupDraft) => {})
    render(
      <RollupSettings
        property={rollup}
        database={owner}
        databases={[owner, databases[1]]}
        currentDatabaseId="tasks"
        onSave={onSave}
      />,
    )
    expect(
      (screen.getByRole("combobox", { name: "Поле связанных страниц" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await chooseOption("Связь", "Project")
    await chooseOption("Поле связанных страниц", "Hours")
    expect(onSave).not.toHaveBeenCalled()
    await chooseOption("Функция", "Сумма")
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1]).toEqual({ relationId: "r", targetId: "h", aggregation: "sum" })
  })
})
