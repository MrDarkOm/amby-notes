// @vitest-environment happy-dom
// Every warning of a note lives in the stack of notices above the bottom bar (docs/sync-plan.md, stage
// Э4б, К3): the strips above the note are gone, and the text of the note is protected while an offer
// to restore an unsaved draft waits for an answer.
import { cleanup, render, screen, within } from "@testing-library/react"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { DocumentEditor, type Document } from "./document-editor"
import type { DocumentBodyProps } from "./document-body"
import { useDocStore } from "../use-doc-store"
import { useVaultStore } from "../use-vault-store"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useSyncNoticesStore } from "../sync/use-sync-notices-store"

const rendered = vi.hoisted(() => ({ bodies: [] as DocumentBodyProps[] }))
vi.mock("./document-header", () => ({ DocumentHeader: () => <header data-testid="header" /> }))
vi.mock("./document-actions", () => ({
  FilePickerModal: () => null,
  LayerConfirmDialog: () => null,
}))
vi.mock("./note-pdf-export", () => ({ NotePdfExport: () => null, NotePdfExportDialog: () => null }))
vi.mock("./document-body", () => ({
  DocumentBody: (props: DocumentBodyProps) => {
    rendered.bodies.push(props)
    return <main data-testid="body" />
  },
}))

const PATH = "/vault/Заметки/идея.md"
const note = (extra: Partial<Document> = {}): Document => ({
  id: PATH,
  title: "идея",
  content: "текст",
  path: PATH,
  modified: "",
  wordCount: 1,
  ...extra,
})

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useDocStore.setState({ openDocs: {}, externalConflicts: {} })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState(useNoteNoticesStore.getInitialState())
})
afterEach(() => {
  cleanup()
  rendered.bodies.length = 0
})

describe("DocumentEditor notices", () => {
  it("has no strip above the note for any warning", () => {
    useSyncNoticesStore.setState({
      conflicts: [
        {
          id: "0123456789ab",
          kind: "bothEdited",
          originalPath: "Заметки/идея.md",
          copyPath: "Заметки/идея.0123456789ab-conflict.md",
          createdMs: 1,
        },
      ],
    })
    useDocStore.setState({
      externalConflicts: {
        [PATH]: {
          fileId: PATH,
          path: PATH,
          localContent: "a",
          externalContent: "b",
          externalRevision: "r",
          sourceTemplate: "b",
        },
      },
    })
    const { container } = render(
      <DocumentEditor
        document={note({
          noteProperties: { parseError: "bad", bodyReadOnly: true } as never,
        })}
      />,
    )
    const stack = screen.getByTestId("note-notices-stack")
    const body = screen.getByTestId("body")
    // everything that warns is inside the stack, which comes after the body (it floats above the bar)
    expect(within(stack).getByText("Автосохранение приостановлено")).toBeTruthy()
    expect(
      within(stack).getByText("Пришла другая версия заметки с другого компьютера"),
    ).toBeTruthy()
    expect(body.compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const outside = [...container.querySelectorAll('[role="alert"], [role="status"]')].filter(
      (element) => !stack.contains(element),
    )
    expect(outside).toEqual([])
    expect(screen.queryByTestId("sync-conflict-banner")).toBeNull()
    expect(screen.queryByTestId("sync-remote-deleted-banner")).toBeNull()
  })

  it("puts a file deleted outside Amby in the stack with its restore button", () => {
    render(
      <DocumentEditor document={note({ externallyDeleted: true })} onRestoreDeleted={vi.fn()} />,
    )
    const stack = screen.getByTestId("note-notices-stack")
    expect(within(stack).getByRole("button", { name: "Восстановить файл" })).toBeTruthy()
  })

  it("shows nothing and no bulb for a note that has nothing to say", () => {
    render(<DocumentEditor document={note()} />)
    expect(screen.queryByTestId("note-notices-bulb")).toBeNull()
    expect(rendered.bodies[rendered.bodies.length - 1]?.isLocked).toBe(false)
  })

  it("keeps the note read only while an unsaved draft waits for an answer", () => {
    render(<DocumentEditor document={note()} />)
    expect(rendered.bodies[rendered.bodies.length - 1]?.isLocked).toBe(false)
    act(() => useNoteNoticesStore.getState().offerDraft(PATH, { accept: vi.fn(), reject: vi.fn() }))
    expect(rendered.bodies[rendered.bodies.length - 1]?.isLocked).toBe(true)
    act(() => useNoteNoticesStore.getState().clearDraftOffer(PATH))
    expect(rendered.bodies[rendered.bodies.length - 1]?.isLocked).toBe(false)
  })
})
