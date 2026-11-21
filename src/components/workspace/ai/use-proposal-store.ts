import { create } from "zustand"
import type { ProposalCard } from "@/lib/bindings"

/** A card and the position of the answer it was proposed in. */
export type PlacedCard = ProposalCard & { at: number }

interface ProposalState {
  /** Cards by chat. They live in memory only: a restart expires them, as the backend does. */
  cards: Record<string, PlacedCard[]>
  /** The conversation's "whole vault" switch; off whenever a chat is opened afresh. */
  vaultWrites: Record<string, boolean>
  add: (chatId: string, card: ProposalCard, at: number) => void
  update: (chatId: string, card: ProposalCard) => void
  setVaultWrites: (chatId: string, on: boolean) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  cards: {},
  vaultWrites: {},
  add: (chatId, card, at) =>
    set((state) => ({
      cards: {
        ...state.cards,
        [chatId]: [
          ...(state.cards[chatId] ?? []).filter((item) => item.id !== card.id),
          { ...card, at },
        ],
      },
    })),
  update: (chatId, card) =>
    set((state) => ({
      cards: {
        ...state.cards,
        [chatId]: (state.cards[chatId] ?? []).map((item) =>
          item.id === card.id ? { ...card, at: item.at } : item,
        ),
      },
    })),
  setVaultWrites: (chatId, on) =>
    set((state) => ({ vaultWrites: { ...state.vaultWrites, [chatId]: on } })),
  reset: () => set({ cards: {}, vaultWrites: {} }),
}))
