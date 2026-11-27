// A question can be closed without an answer (Escape, a click beside the window). Most questions read that as
// "Cancel"; a few cannot, because "no" does something (the draft of a canvas is deleted). `confirmChoice` tells
// the three outcomes apart; `confirm` keeps the two it always had.
import { beforeEach, describe, expect, it } from "vitest"
import { confirm, confirmChoice, useConfirmStore } from "./confirm"

const question = { title: "Восстановить несохранённую версию?", confirmLabel: "Восстановить" }
const current = () => useConfirmStore.getState().queue[0]

beforeEach(() => useConfirmStore.setState(useConfirmStore.getInitialState()))

describe("confirmChoice()", () => {
  it("tells yes, no and closed apart", async () => {
    for (const outcome of ["yes", "no", "dismissed"] as const) {
      const asked = confirmChoice(question)
      useConfirmStore.getState().settle(current().id, outcome)
      await expect(asked).resolves.toBe(outcome)
    }
  })

  it("still takes true and false for yes and no", async () => {
    const yes = confirmChoice(question)
    useConfirmStore.getState().settle(current().id, true)
    await expect(yes).resolves.toBe("yes")
    const no = confirmChoice(question)
    useConfirmStore.getState().settle(current().id, false)
    await expect(no).resolves.toBe("no")
  })
})

describe("confirm() keeps its two answers", () => {
  it("reads 'closed' as Cancel, so the other questions are unchanged", async () => {
    const asked = confirm(question)
    useConfirmStore.getState().settle(current().id, "dismissed")
    await expect(asked).resolves.toBe(false)
  })

  it("reads yes as true and no as false", async () => {
    const yes = confirm(question)
    useConfirmStore.getState().settle(current().id, "yes")
    await expect(yes).resolves.toBe(true)
    const no = confirm(question)
    useConfirmStore.getState().settle(current().id, "no")
    await expect(no).resolves.toBe(false)
  })
})
