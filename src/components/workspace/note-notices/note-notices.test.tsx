// @vitest-environment happy-dom
// The notices of a note above the bottom bar (docs/sync-plan.md, stage Э4б, К3): a stack of cards and a
// bulb with the number. The bulb is there only while there is something to say; urgent cards (a new
// sync conflict, text in danger) open it by themselves; every warning that used to be a strip above the
// note is a card here with the same buttons. Behaviour only; how it looks is checked in a native window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { listTrash, restoreTrash } from "@/lib/storage"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"
import { NoteNotices, type NoteNoticesProps } from "./note-notices"
import { useNoteNoticesStore } from "./use-note-notices-store"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readNote: vi.fn(),
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}))

const ORIGINAL = "Заметки/идея.md"
const COPY = "Заметки/идея.0123456789ab-conflict.md"
const conflict = {
  id: "0123456789ab",
  kind: "bothEdited",
  originalPath: ORIGINAL,
  copyPath: COPY,
  createdMs: 1_760_000_000_000,
}
const ABSOLUTE = `/vault/${ORIGINAL}`

function mount(props: Partial<NoteNoticesProps> = {}) {
  const merged: NoteNoticesProps = {
    document: { id: ABSOLUTE, path: ABSOLUTE },
    warningKey: null,
    ...props,
  }
  return render(<NoteNotices {...merged} />)
}

const bulb = () => screen.queryByTestId("note-notices-bulb")
const stack = () => screen.queryByTestId("note-notices-stack")

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {}, activeConflictDialogFileId: null })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
  vi.mocked(listTrash).mockResolvedValue([])
  vi.mocked(restoreTrash).mockResolvedValue({ changed: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the bulb", () => {
  it("is not there while the note has nothing to say", () => {
    mount()
    expect(bulb()).toBeNull()
    expect(stack()).toBeNull()
  })

  it("appears with the number of notices and opens and hides the stack on a click", () => {
    mount({ warningKey: "workspace.identityReadOnly" })
    const button = bulb()!
    expect(button.textContent).toContain("1")
    expect(button.getAttribute("aria-label")).toMatch(/Уведомления заметки: 1/)
    // a warning does not open by itself
    expect(stack()).toBeNull()
    fireEvent.click(button)
    expect(stack()).not.toBeNull()
    expect(button.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(button)
    expect(stack()).toBeNull()
  })

  it("counts every notice of this note, and no notice of another note", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    useNoteNoticesStore.getState().markRestored(ORIGINAL)
    mount({ warningKey: "workspace.losslessSourceOnly" })
    expect(bulb()!.textContent).toContain("3")
    cleanup()
    mount({ document: { id: "/vault/Заметки/другая.md", path: "/vault/Заметки/другая.md" } })
    expect(bulb()).toBeNull()
  })

  it("goes away when the last notice is resolved", async () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    expect(bulb()).not.toBeNull()
    act(() => useSyncNoticesStore.getState().setConflicts([]))
    await waitFor(() => expect(bulb()).toBeNull())
    expect(stack()).toBeNull()
  })

  it("keeps the number in step as notices come and go", () => {
    mount()
    expect(bulb()).toBeNull()
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, true))
    expect(bulb()!.textContent).toContain("1")
    act(() => useSyncNoticesStore.getState().setConflicts([conflict]))
    expect(bulb()!.textContent).toContain("2")
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, false))
    expect(bulb()!.textContent).toContain("1")
  })
})

describe("what opens the stack by itself", () => {
  it("a new sync conflict, even when the person had hidden the stack", () => {
    mount({ warningKey: "workspace.identityReadOnly" })
    fireEvent.click(bulb()!)
    fireEvent.click(bulb()!)
    expect(stack()).toBeNull()
    act(() => useSyncNoticesStore.getState().setConflicts([conflict]))
    expect(stack()).not.toBeNull()
    expect(
      within(stack()!).getByText("Пришла другая версия заметки с другого компьютера"),
    ).toBeTruthy()
  })

  it("a conflict that was already there when the note was opened", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    expect(stack()).not.toBeNull()
  })

  it("a conflict that is still the same does not open the stack again", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    fireEvent.click(bulb()!)
    expect(stack()).toBeNull()
    act(() => useSyncNoticesStore.getState().setConflicts([{ ...conflict }]))
    expect(stack()).toBeNull()
  })

  it.each([["the note deleted while it was open", { externallyDeleted: true }]])(
    "%s",
    (_name, extra) => {
      mount({ document: { id: ABSOLUTE, path: ABSOLUTE, ...extra } })
      expect(stack()).not.toBeNull()
    },
  )

  it("text that could not be saved", () => {
    mount()
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, true))
    expect(stack()).not.toBeNull()
    expect(within(stack()!).getByText("Не удалось сохранить заметку")).toBeTruthy()
  })

  it("an unsaved draft found after a crash", () => {
    act(() =>
      useNoteNoticesStore.getState().offerDraft(ABSOLUTE, { accept: vi.fn(), reject: vi.fn() }),
    )
    mount()
    expect(stack()).not.toBeNull()
  })

  it("a change made outside Amby while there are unsaved edits", () => {
    useDocStore.setState({
      externalConflicts: {
        [ABSOLUTE]: {
          fileId: ABSOLUTE,
          path: ABSOLUTE,
          localContent: "a",
          externalContent: "b",
          externalRevision: "r",
          sourceTemplate: "b",
        },
      },
    })
    mount()
    expect(stack()).not.toBeNull()
  })
})

describe("the warnings that used to be strips above the note", () => {
  it.each([
    ["workspace.identityReadOnly"],
    ["workspace.losslessSourceOnly"],
    ["workspace.invalidFrontmatter"],
    ["workspace.unterminatedFrontmatter"],
  ])("%s is a card, with its own text", (key) => {
    mount({ warningKey: key })
    fireEvent.click(bulb()!)
    expect(within(stack()!).getByText(i18n.t(key))).toBeTruthy()
  })

  it("a file deleted outside Amby has its text and a button that restores it", async () => {
    const onRestoreDeleted = vi.fn().mockResolvedValue(undefined)
    mount({
      document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true },
      canRestoreDeleted: true,
      onRestoreDeleted,
    })
    expect(within(stack()!).getByText("Файл удалён")).toBeTruthy()
    fireEvent.click(within(stack()!).getByRole("button", { name: "Восстановить файл" }))
    await waitFor(() => expect(onRestoreDeleted).toHaveBeenCalledTimes(1))
  })

  it("shows that the restoring failed and keeps the card", async () => {
    mount({
      document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true },
      canRestoreDeleted: true,
      onRestoreDeleted: vi.fn().mockRejectedValue(new Error("no")),
    })
    fireEvent.click(within(stack()!).getByRole("button", { name: "Восстановить файл" }))
    expect(await within(stack()!).findByText("Не удалось восстановить файл.")).toBeTruthy()
    expect(within(stack()!).getByText("Файл удалён")).toBeTruthy()
  })

  it("offers to close the tab when the deleted file cannot be restored", () => {
    const onCloseTab = vi.fn()
    mount({
      document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true },
      canRestoreDeleted: false,
      onCloseTab,
    })
    fireEvent.click(within(stack()!).getByRole("button", { name: "Закрыть" }))
    expect(onCloseTab).toHaveBeenCalledTimes(1)
  })

  it("a change outside Amby opens the window of the conflict", () => {
    useDocStore.setState({
      externalConflicts: {
        [ABSOLUTE]: {
          fileId: ABSOLUTE,
          path: ABSOLUTE,
          localContent: "a",
          externalContent: "b",
          externalRevision: "r",
          sourceTemplate: "b",
        },
      },
    })
    mount()
    expect(within(stack()!).getByText("Автосохранение приостановлено")).toBeTruthy()
    fireEvent.click(within(stack()!).getByRole("button", { name: "Разрешить конфликт" }))
    expect(useDocStore.getState().activeConflictDialogFileId).toBe(ABSOLUTE)
  })

  it("a deleted file is not said twice with a change outside Amby", () => {
    useDocStore.setState({
      externalConflicts: {
        [ABSOLUTE]: {
          fileId: ABSOLUTE,
          path: ABSOLUTE,
          localContent: "a",
          externalContent: "b",
          externalRevision: "r",
          sourceTemplate: "b",
        },
      },
    })
    mount({ document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } })
    expect(within(stack()!).queryByText("Автосохранение приостановлено")).toBeNull()
    expect(within(stack()!).getByText("Файл удалён")).toBeTruthy()
  })
})

describe("a second version from another computer", () => {
  it("is a card in the main file and in the copy, with a hint about the other file", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    expect(within(stack()!).getByText(`Копия: «${COPY}».`)).toBeTruthy()
    cleanup()
    mount({ document: { id: `/vault/${COPY}`, path: `/vault/${COPY}` } })
    expect(within(stack()!).getByText(`Основной файл: «${ORIGINAL}».`)).toBeTruthy()
  })

  it("opens the comparison from the card", () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    fireEvent.click(within(stack()!).getByRole("button", { name: "Сравнить" }))
    expect(useSyncNoticesStore.getState().compareId).toBe("0123456789ab")
  })

  it("goes away when the conflict is resolved", async () => {
    useSyncNoticesStore.setState({ conflicts: [conflict] })
    mount()
    act(() => useSyncNoticesStore.getState().setConflicts([]))
    await waitFor(() => expect(stack()).toBeNull())
  })
})

describe("a note deleted on another computer", () => {
  const message = "Эту заметку удалили на другом компьютере. Она в архиве хранилища"

  it("is a card with a way back, and it steps in front of the general “deleted” card", () => {
    act(() => useSyncNoticesStore.getState().markRemoteDeleted(ORIGINAL))
    mount({ document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } })
    expect(within(stack()!).getByText(message)).toBeTruthy()
    expect(within(stack()!).queryByText("Файл удалён")).toBeNull()
    expect(bulb()!.textContent).toContain("1")
  })

  it("brings the file back from the archive of the vault and the card goes away", async () => {
    vi.mocked(listTrash).mockResolvedValue([
      { id: "t1", originalPath: ABSOLUTE, deletedAtMs: 2, name: "идея" },
    ] as never)
    act(() => useSyncNoticesStore.getState().markRemoteDeleted(ORIGINAL))
    mount({ document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true } })
    fireEvent.click(within(stack()!).getByRole("button", { name: "Вернуть" }))
    await waitFor(() => expect(restoreTrash).toHaveBeenCalledWith("t1"))
    await waitFor(() => expect(screen.queryByText(message)).toBeNull())
  })

  it("keeps the card and shows an error when the archive does not have it, and the general card returns", async () => {
    act(() => useSyncNoticesStore.getState().markRemoteDeleted(ORIGINAL))
    mount({
      document: { id: ABSOLUTE, path: ABSOLUTE, externallyDeleted: true },
      canRestoreDeleted: true,
      onRestoreDeleted: vi.fn(),
    })
    fireEvent.click(within(stack()!).getByRole("button", { name: "Вернуть" }))
    expect(await within(stack()!).findByText(/Не удалось вернуть заметку из архива/)).toBeTruthy()
    expect(restoreTrash).not.toHaveBeenCalled()
    await waitFor(() => expect(within(stack()!).getByText("Файл удалён")).toBeTruthy())
  })
})

describe("text that could not be saved", () => {
  it("has a button that tries again and goes away when the flag is cleared", () => {
    const saved = vi.fn()
    window.addEventListener("amby:manual-save", saved)
    mount()
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, true))
    fireEvent.click(within(stack()!).getByRole("button", { name: "Сохранить сейчас" }))
    expect(saved).toHaveBeenCalledTimes(1)
    act(() => useNoteNoticesStore.getState().setSaveFailed(ABSOLUTE, false))
    expect(stack()).toBeNull()
    window.removeEventListener("amby:manual-save", saved)
  })
})

describe("an unsaved draft after a crash", () => {
  it("offers to restore it, and the card goes away when the person answers", () => {
    const offer = { accept: vi.fn(), reject: vi.fn() }
    act(() => useNoteNoticesStore.getState().offerDraft(ABSOLUTE, offer))
    mount()
    expect(within(stack()!).getByText("Найдена несохранённая версия")).toBeTruthy()
    fireEvent.click(within(stack()!).getByRole("button", { name: "Восстановить" }))
    expect(offer.accept).toHaveBeenCalledTimes(1)
    expect(offer.reject).not.toHaveBeenCalled()
  })

  it("can be declined", () => {
    const offer = { accept: vi.fn(), reject: vi.fn() }
    act(() => useNoteNoticesStore.getState().offerDraft(ABSOLUTE, offer))
    mount()
    fireEvent.click(within(stack()!).getByRole("button", { name: "Отклонить" }))
    expect(offer.reject).toHaveBeenCalledTimes(1)
    expect(offer.accept).not.toHaveBeenCalled()
  })

  it("disappears once the offer is cleared", () => {
    act(() =>
      useNoteNoticesStore.getState().offerDraft(ABSOLUTE, { accept: vi.fn(), reject: vi.fn() }),
    )
    mount()
    act(() => useNoteNoticesStore.getState().clearDraftOffer(ABSOLUTE))
    expect(bulb()).toBeNull()
  })
})

describe("a note that came back after a deletion made here", () => {
  it("is a card that says so, and the person can close it", () => {
    act(() => useNoteNoticesStore.getState().markRestored(ORIGINAL))
    mount()
    fireEvent.click(bulb()!)
    expect(within(stack()!).getByText(/Заметку «идея» вернули/)).toBeTruthy()
    fireEvent.click(within(stack()!).getByRole("button", { name: "Закрыть" }))
    expect(bulb()).toBeNull()
  })
})
