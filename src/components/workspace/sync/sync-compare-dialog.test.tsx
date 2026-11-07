// @vitest-environment happy-dom
// The comparison window of a sync conflict in Live mode (docs/sync-plan.md, stage Э4б, К4): the two
// versions side by side drawn as a note (read only), the blocks that differ marked, a choice for each,
// and “Собрать из выбранного” (the main button once a choice differs) that hands the assembled text to the port. The assembling itself is tested byte for
// byte in compare/block-compare.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useSyncNoticesStore } from "./use-sync-notices-store"
import { useVaultStore } from "../use-vault-store"
import { useDocStore } from "../use-doc-store"
import i18n from "@/lib/i18n"
import { SyncPortError } from "@/lib/sync/sync-port"
import { createFakePort } from "./fake-sync-port"
import { SyncCompareDialog } from "./sync-compare-dialog"

const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: "Заметки/идея.md",
  copyPath: ".amby/conflicts/0123456789ab/other.md",
  createdMs: 1_760_000_000_000,
}

const MINE = "# Идея\n\nобщий абзац\n\nмой второй абзац\n\n* пункт\n* мой пункт\n"
const OTHER = "# Идея\n\nобщий абзац\n\nих второй абзац\n\n* пункт\n* их пункт\n"

async function open(
  versions: { original: string | null; copy: string | null; stamp?: string } = {
    original: MINE,
    copy: OTHER,
  },
  overrides: Parameters<typeof createFakePort>[0] = {},
  item = conflict,
) {
  const port = createFakePort({
    readConflictVersions: async () => ({ stamp: "stamp-1", ...versions }),
    ...overrides,
  })
  const onClose = vi.fn()
  render(<SyncCompareDialog port={port} conflict={item} vault="/vault" onClose={onClose} />)
  const dialog = await screen.findByRole("dialog")
  return { port, onClose, dialog }
}

/** Chooses `label` for the difference number `index` (0-based). */
function pick(dialog: HTMLElement, index: number, label: "В заметке" | "Вторая" | "Обе") {
  const hunk = within(dialog).getAllByTestId("compare-hunk")[index]!
  fireEvent.click(within(hunk).getByRole("radio", { name: label }))
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the comparison of two versions of a note", () => {
  it("reads both versions through the port, not by path", async () => {
    const { port, dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    expect(port.readConflictVersions).toHaveBeenCalledWith("0123456789ab")
  })

  it("draws the versions as a note and marks the blocks that differ", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    expect(within(dialog).getAllByRole("heading", { level: 1 }).length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText("общий абзац").length).toBeGreaterThan(0)
    const [first] = within(dialog).getAllByTestId("compare-hunk")
    expect(within(first!).getByText("мой второй абзац")).toBeTruthy()
    expect(within(first!).getByText("их второй абзац")).toBeTruthy()
    expect(within(dialog).getByTestId("compare-hunk-count").textContent).toMatch(/2/)
    // read only: nothing to type into
    expect(within(dialog).queryByRole("textbox")).toBeNull()
  })

  it("offers “В заметке”, “Вторая” and “Обе” for each difference, “В заметке” first", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    for (const hunk of within(dialog).getAllByTestId("compare-hunk")) {
      const mine = within(hunk).getByRole("radio", { name: "В заметке" }) as HTMLInputElement
      expect(within(hunk).getByRole("radio", { name: "Вторая" })).toBeTruthy()
      expect(within(hunk).getByRole("radio", { name: "Обе" })).toBeTruthy()
      expect(mine.checked).toBe(true)
    }
  })

  it("assembles the result from the choices and gives it to the port as text", async () => {
    const { port, onClose, dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    const [first, second] = within(dialog).getAllByTestId("compare-hunk")
    fireEvent.click(within(first!).getByRole("radio", { name: "Вторая" }))
    fireEvent.click(within(second!).getByRole("radio", { name: "Обе" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Собрать из выбранного" }))
    await waitFor(() =>
      expect(port.resolveConflictWithText).toHaveBeenCalledWith(
        "0123456789ab",
        "# Идея\n\nобщий абзац\n\nих второй абзац\n\n* пункт\n* мой пункт\n* их пункт\n",
        "stamp-1",
      ),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("keeps the window open and says so when the result could not be saved", async () => {
    const { onClose, dialog } = await open(undefined, {
      resolveConflictWithText: async () => {
        throw new SyncPortError("storage_error")
      },
    })
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    pick(dialog, 0, "Вторая")
    fireEvent.click(within(dialog).getByRole("button", { name: "Собрать из выбранного" }))
    expect(await within(dialog).findByRole("alert")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// The footer of the window: two main buttons and a menu, each one the choice it always was.
describe("the choice of a whole version", () => {
  const menuButton = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Другие варианты" })
  const openMenu = (dialog: HTMLElement) =>
    fireEvent.pointerDown(menuButton(dialog), { button: 0, ctrlKey: false })

  it("has two main buttons and a menu, not four equal buttons", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    expect(within(dialog).getByRole("button", { name: "Оставить версию в заметке" })).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Взять вторую версию" })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /Сохранить обе/ })).toBeNull()
    openMenu(dialog)
    expect(
      await screen.findByRole("menuitem", { name: "Сохранить обе как отдельные заметки" }),
    ).toBeTruthy()
  })

  it.each([
    ["Оставить версию в заметке", "keepOriginal"],
    ["Взять вторую версию", "keepCopy"],
  ])("“%s” is the old choice %s", async (label, choice) => {
    const { port, dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.click(within(dialog).getByRole("button", { name: label }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", choice))
  })

  it("“Сохранить обе как отдельные заметки” in the menu is the old choice keepBoth", async () => {
    const { port, dialog, onClose } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    openMenu(dialog)
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Сохранить обе как отдельные заметки" }),
    )
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepBoth"),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("explains no button: no legend under them", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    expect(dialog.textContent).not.toMatch(/корзин|идентификатор|основной файл|копи/i)
  })
})

// The choice by differences has no button of its own: the main button of the window is the one that
// applies it, so a choice made on a paragraph is never dropped by a button that means something else.
describe("the choice by differences and the main button", () => {
  const FIRST = "Оставить версию в заметке"
  const ASSEMBLE = "Собрать из выбранного"
  const RESET = "Сбросить выбор"
  const SECOND = "Взять вторую версию"
  const button = (dialog: HTMLElement, name: string) =>
    within(dialog).queryByRole("button", { name })
  const ready = async () => {
    const view = await open()
    await waitFor(() => expect(within(view.dialog).getAllByTestId("compare-hunk").length).toBe(2))
    return view
  }

  it("starts with the two buttons and the menu, and nothing to assemble or reset", async () => {
    const { dialog } = await ready()
    expect(button(dialog, FIRST)).not.toBeNull()
    expect(button(dialog, SECOND)).not.toBeNull()
    expect(button(dialog, ASSEMBLE)).toBeNull()
    expect(button(dialog, RESET)).toBeNull()
    expect(button(dialog, "Другие варианты")).not.toBeNull()
  })

  it("makes the main button “Собрать из выбранного” as soon as one difference is chosen otherwise", async () => {
    const { dialog } = await ready()
    pick(dialog, 1, "Обе")
    expect(button(dialog, ASSEMBLE)).not.toBeNull()
    expect(button(dialog, RESET)).not.toBeNull()
    expect(button(dialog, FIRST)).toBeNull()
    expect(button(dialog, SECOND)).toBeNull()
    // the menu stays
    expect(button(dialog, "Другие варианты")).not.toBeNull()
  })

  it("has one place for the button: the footer, not under the differences", async () => {
    const { dialog } = await ready()
    pick(dialog, 0, "Вторая")
    expect(within(dialog).getAllByRole("button", { name: ASSEMBLE })).toHaveLength(1)
    const footer = within(dialog).getByRole("button", { name: "Другие варианты" }).parentElement!
    expect(within(footer).getByRole("button", { name: ASSEMBLE })).toBeTruthy()
  })

  it("“Сбросить выбор” brings the first state back, with every difference on “В заметке”", async () => {
    const { dialog } = await ready()
    pick(dialog, 0, "Вторая")
    pick(dialog, 1, "Обе")
    fireEvent.click(within(dialog).getByRole("button", { name: RESET }))
    expect(button(dialog, FIRST)).not.toBeNull()
    expect(button(dialog, SECOND)).not.toBeNull()
    expect(button(dialog, ASSEMBLE)).toBeNull()
    for (const hunk of within(dialog).getAllByTestId("compare-hunk")) {
      expect(
        (within(hunk).getByRole("radio", { name: "В заметке" }) as HTMLInputElement).checked,
      ).toBe(true)
    }
  })

  it("is the first state again when the choice is put back by hand", async () => {
    const { dialog } = await ready()
    pick(dialog, 0, "Вторая")
    pick(dialog, 0, "В заметке")
    expect(button(dialog, FIRST)).not.toBeNull()
    expect(button(dialog, ASSEMBLE)).toBeNull()
  })

  it("applies the first state with keepOriginal and never with the assembled text", async () => {
    const { port, dialog } = await ready()
    fireEvent.click(within(dialog).getByRole("button", { name: FIRST }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
    expect(port.resolveConflictWithText).not.toHaveBeenCalled()
  })

  it("applies the chosen state with the assembled text and never with a whole-version choice", async () => {
    const { port, dialog } = await ready()
    pick(dialog, 0, "Вторая")
    pick(dialog, 1, "Обе")
    fireEvent.click(within(dialog).getByRole("button", { name: ASSEMBLE }))
    await waitFor(() =>
      expect(port.resolveConflictWithText).toHaveBeenCalledWith(
        "0123456789ab",
        "# Идея\n\nобщий абзац\n\nих второй абзац\n\n* пункт\n* мой пункт\n* их пункт\n",
        "stamp-1",
      ),
    )
    expect(port.resolveConflict).not.toHaveBeenCalled()
  })

  it("a reset only clears the choice: nothing is sent to the port", async () => {
    const { port, dialog } = await ready()
    pick(dialog, 0, "Вторая")
    fireEvent.click(within(dialog).getByRole("button", { name: RESET }))
    expect(port.resolveConflict).not.toHaveBeenCalled()
    expect(port.resolveConflictWithText).not.toHaveBeenCalled()
  })

  it("says the truth when every difference is “Вторая”: it is assembled, the old text is in the history", async () => {
    const { port, dialog } = await ready()
    pick(dialog, 0, "Вторая")
    pick(dialog, 1, "Вторая")
    fireEvent.click(within(dialog).getByRole("button", { name: ASSEMBLE }))
    await waitFor(() => expect(port.resolveConflictWithText).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(useSyncNoticesStore.getState().outcomes[0]?.choice).toBe("assembled"),
    )
    expect(port.resolveConflict).not.toHaveBeenCalled()
  })

  it("leaves the menu working in the chosen state: both versions as notes, the choice by differences does not apply", async () => {
    const { port, dialog } = await ready()
    pick(dialog, 0, "Вторая")
    fireEvent.pointerDown(within(dialog).getByRole("button", { name: "Другие варианты" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Сохранить обе как отдельные заметки" }),
    )
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepBoth"),
    )
    expect(port.resolveConflictWithText).not.toHaveBeenCalled()
  })

  it("has a short line about the choice by differences above them, and none when nothing differs", async () => {
    const { dialog } = await ready()
    expect(within(dialog).getByText("Для каждого отличия можно выбрать своё.")).toBeTruthy()
    cleanup()
    const same = await open({ original: MINE, copy: MINE })
    await waitFor(() => expect(within(same.dialog).getByTestId("compare-hunk-count")).toBeTruthy())
    expect(within(same.dialog).queryByText("Для каждого отличия можно выбрать своё.")).toBeNull()
    expect(button(same.dialog, ASSEMBLE)).toBeNull()
  })

  it("does not offer to assemble a file that is chosen as a whole", async () => {
    const json = {
      ...conflict,
      originalPath: "данные.json",
      copyPath: ".amby/conflicts/0123456789ab/other.json",
    }
    const { dialog } = await open({ original: '{"a":1}', copy: '{"a":2}' }, {}, json)
    await waitFor(() => expect(within(dialog).getByText('{"a":2}')).toBeTruthy())
    expect(button(dialog, ASSEMBLE)).toBeNull()
    expect(button(dialog, RESET)).toBeNull()
  })
})

// By Р7 the path stays with whoever reached the server first and the other version becomes the copy;
// the engine does not record whose version is the copy (a repeat of a whole pass and the tie of two
// new files put the server's version there), so the window does not claim "this" or "the other" computer.
describe("the two sides", () => {
  it("are “Версия в заметке” and “Вторая версия”, without paths or a claim about computers", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    const headings = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
    expect(headings).toEqual(["Версия в заметке", "Вторая версия"])
    const text = dialog.textContent ?? ""
    expect(text).not.toMatch(/\.md|\.amby|conflict|Заметки\//)
    expect(text).not.toMatch(/этот компьютер|другого компьютера|с другого/i)
  })

  it("are named the same way when the file is chosen as a whole", async () => {
    const json = {
      ...conflict,
      originalPath: "данные.json",
      copyPath: ".amby/conflicts/0123456789ab/other.json",
    }
    const { dialog } = await open({ original: '{"a":1}', copy: '{"a":2}' }, {}, json)
    await waitFor(() => expect(within(dialog).getByText('{"a":2}')).toBeTruthy())
    const headings = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
    expect(headings).toEqual(["Версия в заметке", "Вторая версия"])
    expect(dialog.textContent).not.toMatch(/\.json|\.amby/)
  })

  it("carry the time the conflict was found, which is the only time the engine knows", async () => {
    const { dialog } = await open()
    expect(within(dialog).getByText(/Конфликт найден .*2025/)).toBeTruthy()
  })

  it("name the note in the description, without extension", async () => {
    const { dialog } = await open()
    expect(within(dialog).getByText(/«идея»: обе версии целы/)).toBeTruthy()
  })
})

// Nothing is described before the choice (docs/notices.md, section 10): it is made, then said.
describe("after the choice", () => {
  const cases: Array<[string, "keepOriginal" | "keepCopy" | "keepBoth" | "assembled"]> = [
    ["Оставить версию в заметке", "keepOriginal"],
    ["Взять вторую версию", "keepCopy"],
  ]

  it.each(cases)("“%s” leaves a result for the note (%s)", async (label, choice) => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.click(within(dialog).getByRole("button", { name: label }))
    await waitFor(() => expect(useSyncNoticesStore.getState().outcomes).toHaveLength(1))
    expect(useSyncNoticesStore.getState().outcomes[0]).toMatchObject({
      conflictId: "0123456789ab",
      path: "Заметки/идея.md",
      name: "идея",
      choice,
    })
  })

  it("keeping both leaves a result", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.pointerDown(within(dialog).getByRole("button", { name: "Другие варианты" }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Сохранить обе как отдельные заметки" }),
    )
    await waitFor(() => expect(useSyncNoticesStore.getState().outcomes[0]?.choice).toBe("keepBoth"))
  })

  it("assembling from blocks leaves a result", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    pick(dialog, 0, "Вторая")
    fireEvent.click(within(dialog).getByRole("button", { name: "Собрать из выбранного" }))
    await waitFor(() =>
      expect(useSyncNoticesStore.getState().outcomes[0]?.choice).toBe("assembled"),
    )
  })

  it("is a card when the note is open and a line in the list when it is not", async () => {
    useDocStore.setState({
      openDocs: { a: { id: "a", path: "/vault/Заметки/идея.md" } as never },
    })
    const first = await open()
    await waitFor(() => expect(within(first.dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.click(within(first.dialog).getByRole("button", { name: "Оставить версию в заметке" }))
    await waitFor(() => expect(useSyncNoticesStore.getState().outcomes[0]?.where).toBe("card"))
    cleanup()
    useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
    useDocStore.setState({ openDocs: {} })
    const second = await open()
    await waitFor(() => expect(within(second.dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.click(
      within(second.dialog).getByRole("button", { name: "Оставить версию в заметке" }),
    )
    await waitFor(() => expect(useSyncNoticesStore.getState().outcomes[0]?.where).toBe("list"))
  })

  it("leaves nothing when the choice could not be made", async () => {
    const { dialog } = await open(undefined, {
      resolveConflict: async () => {
        throw new SyncPortError("storage_error")
      },
    })
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.click(within(dialog).getByRole("button", { name: "Взять вторую версию" }))
    expect(await within(dialog).findByRole("alert")).toBeTruthy()
    expect(useSyncNoticesStore.getState().outcomes).toEqual([])
  })
})

describe("when Live Preview cannot take a version", () => {
  const refused = "[метка][ref]\n\nмой абзац\n\n[ref]: https://example.com\n"
  const refusedOther = "[метка][ref]\n\nих абзац\n\n[ref]: https://example.com\n"

  it("opens the comparison in the source view, still with a choice for each difference", async () => {
    const { port, dialog } = await open({ original: refused, copy: refusedOther })
    await waitFor(() => expect(within(dialog).getByTestId("compare-source")).toBeTruthy())
    const [hunk] = within(dialog).getAllByTestId("compare-hunk")
    expect(hunk!.querySelector("pre")).not.toBeNull()
    fireEvent.click(within(hunk!).getByRole("radio", { name: "Вторая" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Собрать из выбранного" }))
    await waitFor(() =>
      expect(port.resolveConflictWithText).toHaveBeenCalledWith(
        "0123456789ab",
        refusedOther,
        "stamp-1",
      ),
    )
  })
})

describe("a file that is not a note", () => {
  it("is chosen as a whole, with its text shown when it is text", async () => {
    const json = {
      ...conflict,
      originalPath: "данные.json",
      copyPath: ".amby/conflicts/0123456789ab/other.json",
    }
    const { port, dialog } = await open({ original: '{"a":1}', copy: '{"a":2}' }, {}, json)
    await waitFor(() => expect(within(dialog).getByText('{"a":2}')).toBeTruthy())
    expect(within(dialog).queryAllByTestId("compare-hunk")).toHaveLength(0)
    expect(within(dialog).queryByRole("button", { name: "Собрать из выбранного" })).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: "Оставить версию в заметке" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
  })

  it("shows that a version is not text and still lets the person choose", async () => {
    const image = {
      ...conflict,
      originalPath: "схема.png",
      copyPath: ".amby/conflicts/0123456789ab/other.png",
    }
    const { dialog } = await open({ original: null, copy: null }, {}, image)
    expect(await within(dialog).findAllByText("Это не текст: показать нечего")).toHaveLength(2)
    expect(within(dialog).getByRole("button", { name: "Взять вторую версию" })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Собрать из выбранного" })).toBeNull()
  })

  it("says so when the versions could not be read", async () => {
    const { dialog } = await open(undefined, {
      readConflictVersions: async () => {
        throw new SyncPortError("storage_error")
      },
    })
    expect(await within(dialog).findByRole("alert")).toBeTruthy()
  })
})

describe("when a version changed while the person compared", () => {
  it("writes nothing, says so, and reads the versions again", async () => {
    let reads = 0
    const { port, onClose, dialog } = await open(undefined, {
      readConflictVersions: async () => {
        reads += 1
        return { original: MINE, copy: OTHER, stamp: `stamp-${reads}` }
      },
      resolveConflictWithText: async () => {
        throw new SyncPortError("conflict_changed")
      },
    })
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    pick(dialog, 0, "Вторая")
    fireEvent.click(within(dialog).getByRole("button", { name: "Собрать из выбранного" }))
    expect(await within(dialog).findByRole("alert")).toBeTruthy()
    expect(within(dialog).getByRole("alert").textContent).toMatch(
      /Пока вы сравнивали, пришла новая версия/,
    )
    await waitFor(() => expect(reads).toBe(2))
    expect(onClose).not.toHaveBeenCalled()
    // the next try carries the new stamp
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    // a new reading starts from the first choice again: the versions are not the ones that were chosen on
    pick(dialog, 0, "Вторая")
    fireEvent.click(within(dialog).getByRole("button", { name: "Собрать из выбранного" }))
    await waitFor(() =>
      expect(port.resolveConflictWithText).toHaveBeenLastCalledWith(
        "0123456789ab",
        expect.any(String),
        "stamp-2",
      ),
    )
  })
})
