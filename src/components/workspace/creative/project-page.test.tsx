// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { useCreativeNavStore } from "./creative-nav-store"
import { catalog, project, section, universeCatalog } from "./project-fixtures.test-support"
import { ProjectPage } from "./project-page"
import { useProjectStore } from "./project-store"

vi.mock("./create-section-dialog", () => ({
  CreateSectionDialog: () => <div data-testid="section-dialog" />,
}))

function mount(projectId: string) {
  const onOpenProject = vi.fn()
  const renderDatabase = vi.fn(({ databaseId, title }: { databaseId: string; title: string }) => (
    <div data-testid="database">{`${title}:${databaseId}`}</div>
  ))
  render(
    <ProjectPage
      projectId={projectId}
      renderDatabase={renderDatabase}
      onOpenProject={onOpenProject}
    />,
  )
  return { onOpenProject, renderDatabase }
}

describe("ProjectPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    useProjectStore.getState().reset()
    useCreativeNavStore.setState({ sectionByProject: {}, collapsed: {} })
  })
  afterEach(cleanup)

  it("waits for the catalog and then says a missing project is missing", () => {
    useProjectStore.getState().setLoading()
    mount("nope")
    expect(screen.getByText("Загрузка…")).toBeTruthy()
    cleanup()
    act(() => useProjectStore.getState().setCatalog(catalog([])))
    mount("nope")
    expect(screen.getByText("Проект не найден")).toBeTruthy()
  })

  it("starts on the overview, with the sections of a story under their groups", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { renderDatabase } = mount("molehills")
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("MoleHills")
    expect(screen.getByText("История")).toBeTruthy()
    expect(renderDatabase).not.toHaveBeenCalled()
    // cards on the overview: one per section
    expect(screen.getAllByRole("button", { name: /Текст/u }).length).toBeGreaterThan(0)
  })

  it("shows a section as the ordinary database and remembers it", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { renderDatabase } = mount("molehills")
    const nav = screen.getByRole("navigation", { name: "Разделы проекта" })
    fireEvent.click(
      Array.from(nav.querySelectorAll("button")).find((b) => b.textContent === "Текст")!,
    )
    expect(renderDatabase).toHaveBeenLastCalledWith({ databaseId: "db_text", title: "Текст" })
    expect(screen.getByTestId("database").textContent).toBe("Текст:db_text")
    expect(useCreativeNavStore.getState().sectionByProject.molehills).toBe("text")
  })

  it("opens the section the sidebar asked for", () => {
    act(() => {
      useProjectStore.getState().setCatalog(universeCatalog())
      useCreativeNavStore.getState().showSection("molehills", "notes")
    })
    mount("molehills")
    expect(screen.getByTestId("database").textContent).toBe("Заметки:db_notes")
  })

  it("falls back to the overview when the remembered section no longer exists", () => {
    act(() => {
      useProjectStore.getState().setCatalog(universeCatalog())
      useCreativeNavStore.getState().showSection("molehills", "gone")
    })
    mount("molehills")
    expect(screen.queryByTestId("database")).toBeNull()
  })

  it("lists the stories of a collection and opens one", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    const { onOpenProject } = mount("palooverse")
    expect(screen.getByText("Истории")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "MoleHills" }))
    expect(onOpenProject).toHaveBeenCalledWith("molehills")
  })

  it("explains a section whose database is missing instead of rendering it", () => {
    const broken = project("p", {
      sections: [section("s", { state: "missing", resolvedPath: null, databaseName: "Потеряна" })],
    })
    act(() => {
      useProjectStore.getState().setCatalog(catalog([broken]))
      useCreativeNavStore.getState().showSection("p", "s")
    })
    const { renderDatabase } = mount("p")
    expect(renderDatabase).not.toHaveBeenCalled()
    expect(screen.getByText("База не найдена")).toBeTruthy()
  })

  it("is read-only for a project of an unknown format", () => {
    act(() =>
      useProjectStore
        .getState()
        .setCatalog(catalog([project("p", { readOnly: true, formatVersion: 3 })])),
    )
    mount("p")
    expect(screen.getByText(/версия 3/u)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Раздел" })).toBeNull()
  })

  it("adds a section from the header", () => {
    act(() => useProjectStore.getState().setCatalog(universeCatalog()))
    mount("molehills")
    fireEvent.click(screen.getByRole("button", { name: "Раздел" }))
    expect(screen.getByTestId("section-dialog")).toBeTruthy()
  })
})
