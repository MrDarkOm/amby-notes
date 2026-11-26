// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { WordGoal } from "./word-goal"

describe("WordGoal", () => {
  const onSetGoal = vi.fn()
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    onSetGoal.mockReset()
  })
  afterEach(cleanup)

  it("offers to set a daily goal and takes a number of words", () => {
    render(<WordGoal goal={null} written={0} streak={0} canEdit onSetGoal={onSetGoal} />)
    fireEvent.click(screen.getByRole("button", { name: "Поставить цель на день" }))
    const field = screen.getByLabelText("Слов в день")
    fireEvent.change(field, { target: { value: "500" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onSetGoal).toHaveBeenCalledWith(500)
  })

  it("refuses a goal that is not a positive whole number", () => {
    render(<WordGoal goal={null} written={0} streak={0} canEdit onSetGoal={onSetGoal} />)
    fireEvent.click(screen.getByRole("button", { name: "Поставить цель на день" }))
    const field = screen.getByLabelText("Слов в день")
    fireEvent.change(field, { target: { value: "-3" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onSetGoal).not.toHaveBeenCalled()
  })

  it("shows today against the goal and the streak, and can remove the goal", () => {
    render(<WordGoal goal={500} written={120} streak={3} canEdit onSetGoal={onSetGoal} />)
    expect(screen.getByText("Сегодня 120 из 500 слов")).toBeTruthy()
    expect(screen.getByText("Серия: 3 дн.")).toBeTruthy()
    expect(
      screen.getByRole("progressbar", { name: "Цель на день" }).getAttribute("aria-valuenow"),
    ).toBe("24")
    fireEvent.click(screen.getByRole("button", { name: "Убрать цель" }))
    expect(onSetGoal).toHaveBeenCalledWith(null)
  })

  it("shows nothing to change when the story is read only", () => {
    render(<WordGoal goal={null} written={0} streak={0} canEdit={false} onSetGoal={onSetGoal} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
