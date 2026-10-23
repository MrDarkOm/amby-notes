// @vitest-environment happy-dom
// The comparison window of a sync conflict in Live mode (docs/sync-plan.md, stage Э4б, К4): the two
// versions side by side drawn as a note (read only), the blocks that differ marked, a choice for each,
// and “Готово” that hands the assembled text to the port. The assembling itself is tested byte for
// byte in compare/block-compare.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { SyncPortError } from "@/lib/sync/sync-port"
import { createFakePort } from "./fake-sync-port"
import { SyncCompareDialog } from "./sync-compare-dialog"

const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: "Заметки/идея.md",
  copyPath: "Заметки/идея.0123456789ab-conflict.md",
  createdMs: 1_760_000_000_000,
}

const MINE = "# Идея\n\nобщий абзац\n\nмой второй абзац\n\n* пункт\n* мой пункт\n"
const OTHER = "# Идея\n\nобщий абзац\n\nих второй абзац\n\n* пункт\n* их пункт\n"

async function open(
  versions: { original: string | null; copy: string | null } = { original: MINE, copy: OTHER },
  overrides: Parameters<typeof createFakePort>[0] = {},
  item = conflict,
) {
  const port = createFakePort({ readConflictVersions: async () => versions, ...overrides })
  const onClose = vi.fn()
  render(<SyncCompareDialog port={port} conflict={item} vault="/vault" onClose={onClose} />)
  const dialog = await screen.findByRole("dialog")
  return { port, onClose, dialog }
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
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

  it("offers “Моя”, “Другая” and “Обе” for each difference, “Моя” first", async () => {
    const { dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    for (const hunk of within(dialog).getAllByTestId("compare-hunk")) {
      const mine = within(hunk).getByRole("radio", { name: "Моя" }) as HTMLInputElement
      expect(within(hunk).getByRole("radio", { name: "Другая" })).toBeTruthy()
      expect(within(hunk).getByRole("radio", { name: "Обе" })).toBeTruthy()
      expect(mine.checked).toBe(true)
    }
  })

  it("assembles the result from the choices and gives it to the port as text", async () => {
    const { port, onClose, dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    const [first, second] = within(dialog).getAllByTestId("compare-hunk")
    fireEvent.click(within(first!).getByRole("radio", { name: "Другая" }))
    fireEvent.click(within(second!).getByRole("radio", { name: "Обе" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Готово" }))
    await waitFor(() =>
      expect(port.resolveConflictWithText).toHaveBeenCalledWith(
        "0123456789ab",
        "# Идея\n\nобщий абзац\n\nих второй абзац\n\n* пункт\n* мой пункт\n* их пункт\n",
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Готово" }))
    expect(await within(dialog).findByRole("alert")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("still has the three ways of choosing a whole file", async () => {
    const { port, dialog } = await open()
    await waitFor(() => expect(within(dialog).getAllByTestId("compare-hunk").length).toBe(2))
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить копией" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepCopy"),
    )
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
    fireEvent.click(within(hunk!).getByRole("radio", { name: "Другая" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Готово" }))
    await waitFor(() =>
      expect(port.resolveConflictWithText).toHaveBeenCalledWith("0123456789ab", refusedOther),
    )
  })
})

describe("a file that is not a note", () => {
  it("is chosen as a whole, with its text shown when it is text", async () => {
    const json = {
      ...conflict,
      originalPath: "данные.json",
      copyPath: "данные.0123456789ab-conflict.json",
    }
    const { port, dialog } = await open({ original: '{"a":1}', copy: '{"a":2}' }, {}, json)
    await waitFor(() => expect(within(dialog).getByText('{"a":2}')).toBeTruthy())
    expect(within(dialog).queryAllByTestId("compare-hunk")).toHaveLength(0)
    expect(within(dialog).queryByRole("button", { name: "Готово" })).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: "Оставить основной файл" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
  })

  it("shows that a version is not text and still lets the person choose", async () => {
    const image = {
      ...conflict,
      originalPath: "схема.png",
      copyPath: "схема.0123456789ab-conflict.png",
    }
    const { dialog } = await open({ original: null, copy: null }, {}, image)
    expect(await within(dialog).findAllByText("Это не текст: показать нечего")).toHaveLength(2)
    expect(within(dialog).getByRole("button", { name: "Заменить копией" })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Готово" })).toBeNull()
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
