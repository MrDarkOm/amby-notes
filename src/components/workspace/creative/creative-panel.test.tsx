// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import type { PanelRenderProps } from "../panel-registry"
import { CreativePanel } from "./creative-panel"
import { useCreativeNavStore } from "./creative-nav-store"
import { catalog, project, section, universeCatalog } from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"

vi.mock("./create-project-dialog", () => ({
  CreateProjectDialog: (props: { open: boolean; parent?: { name: string } | null }) =>
    props.open ? <div data-testid="project-dialog">{props.parent?.name ?? "root"}</div> : null,
}))
vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: (props: { project: { name: string } }) => (
    <div data-testid="section-dialog">{props.project.name}</div>
  ),
}))

const props = (extra: Partial<PanelRenderProps> = {}) =>
  ({ databaseRuntimeEnabled: true, ...extra }) as PanelRenderProps

describe("CreativePanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useProjectStore.getState().reset()
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {} })
  })
  afterEach(cleanup)

  it("explains that databases are needed when the module is off", () => {
    render(<CreativePanel {...props({ databaseRuntimeEnabled: false })} />)
    expect(screen.getByText("Нужен модуль «Базы данных»")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Новый проект" })).toBeNull()
  })

  it("offers the first project when there is none", () => {
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    render(<CreativePanel {...props()} />)
    expect(screen.getByText("Проектов пока нет")).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "Новый проект" })[0])
    expect(screen.getByTestId("project-dialog").textContent).toBe("root")
  })

  it("lists a universe with its stories and sections, grouped", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    render(<CreativePanel {...props()} />)
    for (const name of ["Palooverse", "MoleHills", "Рассказ", "Персонажи", "Заметки", "Текст"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByText("Мир").length).toBeGreaterThan(0)
    expect(screen.getByText("Произведение")).toBeTruthy()
  })

  it("opens a project and a section in it", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const onOpen = vi.fn()
    render(<CreativePanel {...props({ onOpenCreativeProject: onOpen })} />)
    fireEvent.click(screen.getByRole("button", { name: "Рассказ" }))
    expect(onOpen).toHaveBeenLastCalledWith("tale", undefined)
    fireEvent.click(screen.getByRole("button", { name: "Заметки" }))
    expect(onOpen).toHaveBeenLastCalledWith("molehills", "notes")
  })

  it("folds a project", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    render(<CreativePanel {...props()} />)
    expect(screen.getByRole("button", { name: "Заметки" })).toBeTruthy()
    const story = screen.getByRole("button", { name: "MoleHills" }).parentElement!
    fireEvent.click(within(story).getByRole("button", { name: "Свернуть" }))
    expect(screen.queryByRole("button", { name: "Заметки" })).toBeNull()
  })

  it("starts a story from a collection and a section from a story", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "Новая история" }))
    expect(screen.getByTestId("project-dialog").textContent).toBe("Palooverse")
    const story = screen.getByRole("button", { name: "MoleHills" }).parentElement!
    fireEvent.click(within(story).getByRole("button", { name: "Раздел" }))
    expect(screen.getByTestId("section-dialog").textContent).toBe("MoleHills")
  })

  it("marks a missing section and a read-only project, and offers no editing for the latter", () => {
    const broken = project("broken", {
      readOnly: true,
      sections: [section("s", { state: "missing", resolvedPath: null, databaseName: null })],
    })
    act(() => useProjectStore.getState().setCatalog(catalog([broken])))
    render(<CreativePanel {...props()} />)
    expect(screen.getByLabelText("Проект в неизвестном формате: только чтение")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Раздел" })).toBeNull()
    expect(screen.getByLabelText("База раздела не найдена")).toBeTruthy()
  })

  it("counts diagnostics and shows them on request", () => {
    act(() =>
      useProjectStore.getState().setCatalog(
        catalog([project("a")], {
          diagnostics: [
            {
              code: "duplicateProjectId",
              severity: "error",
              path: "B/amby-project.json",
              projectId: "a",
              detail: null,
            },
            {
              code: "nestedCollection",
              severity: "warning",
              path: "C/amby-project.json",
              projectId: null,
              detail: null,
            },
          ],
        }),
      ),
    )
    render(<CreativePanel {...props()} />)
    fireEvent.click(screen.getByText("2 замечания к проектам"))
    expect(screen.getByText("B/amby-project.json")).toBeTruthy()
    expect(screen.getByText("Сборник внутри сборника не поддерживается")).toBeTruthy()
  })

  it("shows a load failure with a retry", () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    act(() => {
      useProjectStore.getState().setRefresh(refresh)
      useProjectStore.getState().setError("boom")
    })
    render(<CreativePanel {...props()} />)
    expect(screen.getByText("boom")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }))
    expect(refresh).toHaveBeenCalledWith(true)
  })
})
