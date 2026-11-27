// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { StoryCard } from "./story-card"
import type { StoryEntry } from "./story-list-model"

const entry = (overrides: Partial<StoryEntry> = {}): StoryEntry => ({
  storyId: "s",
  name: "История",
  cardNoteId: "card_s",
  universeId: null,
  universeName: null,
  finished: false,
  favorite: false,
  words: 10,
  pages: 2,
  donePages: 1,
  lastModified: null,
  created: null,
  ...overrides,
})

describe("StoryCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("stars the story's card by its note ID, the key of Amby's favorites", () => {
    const onToggleFavorite = vi.fn()
    render(<StoryCard entry={entry()} onOpen={vi.fn()} onToggleFavorite={onToggleFavorite} />)
    fireEvent.click(screen.getByRole("button", { name: "В избранное" }))
    expect(onToggleFavorite).toHaveBeenCalledWith("card_s")
  })

  it("has no star for a story without a card, which has nothing to favorite", () => {
    render(
      <StoryCard entry={entry({ cardNoteId: null })} onOpen={vi.fn()} onToggleFavorite={vi.fn()} />,
    )
    expect(screen.queryByRole("button", { name: /избранн/ })).toBeNull()
    expect(screen.getByRole("button", { name: /История/ })).toBeTruthy()
  })

  it("opens the story from the card, not from the star", () => {
    const onOpen = vi.fn()
    render(<StoryCard entry={entry()} onOpen={onOpen} onToggleFavorite={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /История/ }))
    expect(onOpen).toHaveBeenCalledWith("s")
  })
})
