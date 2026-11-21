import { create } from "zustand"
import type { ProposalCard } from "@/lib/bindings"

/** How the AI's changes are approved: by hand, at once (with Undo), or without any stop. */
export type ApprovalMode = "manual" | "auto" | "turbo"

/** A card and the position of the answer it was proposed in. */
export type PlacedCard = ProposalCard & { at: number; auto: boolean }

interface ProposalState {
  /** Cards by chat. They live in memory only: a restart expires them, as the backend does. */
  cards: Record<string, PlacedCard[]>
  /** The conversation's "whole vault" switch; off whenever a chat is opened afresh. */
  vaultWrites: Record<string, boolean>
  /** The conversation's approval mode; manual whenever a chat is opened afresh. */
  modes: Record<string, ApprovalMode>
  /** `auto`: the card is applied as soon as its note has no unsaved edits. */
  add: (chatId: string, card: ProposalCard, at: number, auto?: boolean) => void
  update: (chatId: string, card: ProposalCard) => void
  setVaultWrites: (chatId: string, on: boolean) => void
  setMode: (chatId: string, mode: ApprovalMode) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  cards: {},
  vaultWrites: {},
  modes: {},
  add: (chatId, card, at, auto = false) =>
    set((state) => ({
      cards: {
        ...state.cards,
        [chatId]: [
          ...(state.cards[chatId] ?? []).filter((item) => item.id !== card.id),
          { ...card, at, auto },
        ],
      },
    })),
  update: (chatId, card) =>
    set((state) => ({
      cards: {
        ...state.cards,
        [chatId]: (state.cards[chatId] ?? []).map((item) =>
          item.id === card.id ? { ...card, at: item.at, auto: item.auto } : item,
        ),
      },
    })),
  setVaultWrites: (chatId, on) =>
    set((state) => ({ vaultWrites: { ...state.vaultWrites, [chatId]: on } })),
  setMode: (chatId, mode) => set((state) => ({ modes: { ...state.modes, [chatId]: mode } })),
  reset: () => set({ cards: {}, vaultWrites: {}, modes: {} }),
}))
