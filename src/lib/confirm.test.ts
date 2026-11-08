// The question of the application (docs/notices.md, section 9): one promise, one store, one queue.
import { beforeEach, describe, expect, it } from "vitest"
import { confirm, useConfirmStore } from "./confirm"

const question = (title: string) => ({
  title,
  description: "Заметка попадёт в корзину хранилища, её можно вернуть.",
  confirmLabel: "Удалить",
  destructive: true,
})
const current = () => useConfirmStore.getState().queue[0]

beforeEach(() => useConfirmStore.setState(useConfirmStore.getInitialState()))

describe("confirm()", () => {
  it("waits for the person: nothing is answered by itself", async () => {
    let answered = false
    void confirm(question("Удалить «План»?")).then(() => (answered = true))
    await Promise.resolve()
    expect(answered).toBe(false)
    expect(current()).toMatchObject({ title: "Удалить «План»?", destructive: true })
  })

  it("answers true to yes and false to cancel", async () => {
    const yes = confirm(question("Удалить «План»?"))
    useConfirmStore.getState().settle(current().id, true)
    await expect(yes).resolves.toBe(true)

    const no = confirm(question("Удалить «Идея»?"))
    useConfirmStore.getState().settle(current().id, false)
    await expect(no).resolves.toBe(false)
    expect(useConfirmStore.getState().queue).toEqual([])
  })

  it("shows questions one at a time, in the order they were asked", async () => {
    const first = confirm(question("Первый?"))
    const second = confirm(question("Второй?"))
    expect(current().title).toBe("Первый?")
    expect(useConfirmStore.getState().queue).toHaveLength(2)
    useConfirmStore.getState().settle(current().id, true)
    await expect(first).resolves.toBe(true)
    expect(current().title).toBe("Второй?")
    useConfirmStore.getState().settle(current().id, false)
    await expect(second).resolves.toBe(false)
  })

  it("ignores a second answer to the same question: the first one stands", async () => {
    const asked = confirm(question("Удалить «План»?"))
    const { id } = current()
    useConfirmStore.getState().settle(id, false)
    useConfirmStore.getState().settle(id, true)
    await expect(asked).resolves.toBe(false)
  })

  it("answers the question that is asked, not the one that follows it", async () => {
    const first = confirm(question("Первый?"))
    void confirm(question("Второй?"))
    const { id } = current()
    useConfirmStore.getState().settle(id, true)
    // A late "no" to the first question must not close the second.
    useConfirmStore.getState().settle(id, false)
    await expect(first).resolves.toBe(true)
    expect(current().title).toBe("Второй?")
  })
})
