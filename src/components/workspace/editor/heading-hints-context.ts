import { createContext } from "react"

/** Optional view-only placeholders supplied by the note's frame. */
export const HeadingHintsContext = createContext<ReadonlyMap<string, string> | null>(null)
