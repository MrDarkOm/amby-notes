import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildAttachedContext, currentContext, MAX_ATTACHED_CHARS } from "./context"
import { useVaultStore } from "../use-vault-store"
import * as storage from "@/lib/storage"
import type { Document } from "../use-doc-store"

vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  readNote: vi.fn(),
}))

const items = [
  {
    id: "folder",
    path: "/vault/folder",
    name: "folder",
    type: "folder" as const,
    children: [{ id: "b", path: "/vault/folder/b.md", name: "b.md", type: "file" as const }],
  },
  { id: "a", path: "/vault/a.md", name: "a.md", type: "file" as const },
]
const doc = {
  id: "a",
  title: "A",
  content: "😀".repeat(MAX_ATTACHED_CHARS + 1),
  source: "",
  path: "/vault/a.md",
  created: "",
  modified: "",
  wordCount: 0,
} satisfies Document

beforeEach(() => {
  useVaultStore.setState({
    ...useVaultStore.getInitialState(),
    vault: "/vault",
    backendGeneration: 9,
    switching: false,
  })
  vi.clearAllMocks()
})

describe("AI attached context", () => {
  it("replaces only automatic current context and preserves manual attachments", () => {
    expect(
      currentContext(
        [
          { kind: "current", id: "old" },
          { kind: "note", id: "b" },
        ],
        "a",
        true,
      ),
    ).toEqual([
      { kind: "current", id: "a" },
      { kind: "note", id: "b" },
    ])
    expect(currentContext([{ kind: "current", id: "a" }], "b", false)).toEqual([])
  })

  // AI1-C1/C3/C5: use the buffer, bound text by characters, and list folders without their contents.
  it("uses the unsaved buffer, marks clipping and lists folder notes without reading them", async () => {
    const result = await buildAttachedContext({
      context: [
        { kind: "current", id: "a" },
        { kind: "folder", id: "folder" },
      ],
      items,
      openDocs: { a: doc },
      vault: "/vault",
      generation: 9,
      language: "English",
    })
    expect(result.truncated).toEqual(["a"])
    expect(result.system).toContain("[truncated]")
    expect(Array.from(result.system.match(/😀/gu) ?? [])).toHaveLength(MAX_ATTACHED_CHARS)
    expect(result.system).toContain("b.md (id: b)")
    expect(storage.readNote).not.toHaveBeenCalled()
    expect(result.sources).toEqual([{ id: "a", title: "A" }])
  })

  it("does not return text read after the vault changes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof storage.readNote>>) => void
    vi.mocked(storage.readNote).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const result = buildAttachedContext({
      context: [{ kind: "note", id: "b" }],
      items,
      openDocs: {},
      vault: "/vault",
      generation: 9,
      language: "English",
    })
    useVaultStore.setState({ backendGeneration: 10 })
    finish({ content: "wrong vault", source: "", revision: "r" })
    await expect(result).rejects.toThrow("Vault changed")
  })
})
