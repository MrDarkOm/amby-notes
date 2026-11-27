import { create } from "zustand"

/** A text file the person attached to the next message. It is read in the window and never stored. */
export interface AttachedFile {
  name: string
  text: string
  size: number
}

export const MAX_ATTACHED_FILES = 5
export const MAX_FILE_BYTES = 200 * 1024
/** What all attached files may add to the context together, in characters. */
// With the notes, the context must stay under the 128 KB limit of a system prompt, even in 3-byte text.
export const MAX_FILES_CHARS = 30_000

export type AttachError = "tooMany" | "tooLarge" | "notText"

const decoder = () => new TextDecoder("utf-8", { fatal: true })

/**
 * Reads the chosen files as text. A file that is too large, is not valid UTF-8 text or would
 * exceed the limits is left out, and the first reason is returned so the person can be told.
 */
export async function readTextFiles(
  files: File[],
  existing: AttachedFile[],
): Promise<{ added: AttachedFile[]; error: AttachError | null }> {
  const added: AttachedFile[] = []
  let error: AttachError | null = null
  let chars = existing.reduce((sum, file) => sum + file.text.length, 0)
  for (const file of files) {
    if (existing.length + added.length >= MAX_ATTACHED_FILES) {
      error ??= "tooMany"
      break
    }
    if (file.size > MAX_FILE_BYTES) {
      error ??= "tooLarge"
      continue
    }
    let text: string
    try {
      text = decoder().decode(await file.arrayBuffer())
    } catch {
      error ??= "notText"
      continue
    }
    if (text.includes("\0") || text.trim() === "") {
      error ??= "notText"
      continue
    }
    if (chars + text.length > MAX_FILES_CHARS) {
      error ??= "tooLarge"
      continue
    }
    if (existing.some((item) => item.name === file.name && item.text === text)) continue
    chars += text.length
    added.push({ name: file.name, text, size: file.size })
  }
  return { added, error }
}

interface AttachmentState {
  /** By chat; in memory only. */
  files: Record<string, AttachedFile[]>
  add: (chatId: string, files: AttachedFile[]) => void
  remove: (chatId: string, index: number) => void
  clear: (chatId: string) => void
}

export const useAttachmentStore = create<AttachmentState>((set) => ({
  files: {},
  add: (chatId, files) =>
    set((state) => ({
      files: { ...state.files, [chatId]: [...(state.files[chatId] ?? []), ...files] },
    })),
  remove: (chatId, index) =>
    set((state) => ({
      files: {
        ...state.files,
        [chatId]: (state.files[chatId] ?? []).filter((_, i) => i !== index),
      },
    })),
  clear: (chatId) => set((state) => ({ files: { ...state.files, [chatId]: [] } })),
}))
