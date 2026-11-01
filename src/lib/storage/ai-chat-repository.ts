import { commands, type AiConfig, type Chat, type ChatEntry, type LoadedChat } from "../bindings"
import { unwrapCommand } from "./ipc-result"

export type {
  Chat,
  ChatContext,
  ChatEntry,
  ChatMessage,
  ChatSource,
  ChatStep,
  LoadedChat,
} from "../bindings"

export interface AiChatRepository {
  available: boolean
  list(generation: number): Promise<ChatEntry[]>
  load(generation: number, id: string): Promise<LoadedChat>
  save(generation: number, chat: Chat, expectedRevision: string | null): Promise<string>
  trash(generation: number, id: string, expectedRevision: string): Promise<void>
  consent(generation: number, config: AiConfig): Promise<string>
  setConsent(generation: number, config: AiConfig, allowed: boolean): Promise<void>
}

const unavailable = async (): Promise<never> => {
  throw new Error("AI conversation storage is unavailable")
}

export function createAiChatRepository(native: boolean): AiChatRepository {
  if (!native)
    return {
      available: false,
      list: unavailable,
      load: unavailable,
      save: unavailable,
      trash: unavailable,
      consent: unavailable,
      setConsent: unavailable,
    }
  return {
    available: true,
    list: (generation) => unwrapCommand(commands.aiListChats(generation)),
    load: (generation, id) => unwrapCommand(commands.aiLoadChat(generation, id)),
    save: (generation, chat, expectedRevision) =>
      unwrapCommand(commands.aiSaveChat(generation, chat, expectedRevision)),
    trash: (generation, id, expectedRevision) =>
      unwrapCommand(commands.aiTrashChat(generation, id, expectedRevision)).then(() => undefined),
    consent: (generation, config) => unwrapCommand(commands.aiSearchConsent(generation, config)),
    setConsent: (generation, config, allowed) =>
      unwrapCommand(commands.aiSetSearchConsent(generation, config, allowed)).then(() => undefined),
  }
}
