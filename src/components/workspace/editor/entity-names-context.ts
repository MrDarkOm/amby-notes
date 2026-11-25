import { createContext } from "react"
import type { EntityNames } from "../tiptap/entity-names"

/** The names of the world a page of a story's text marks on screen, supplied by its frame. */
export const EntityNamesContext = createContext<EntityNames | null>(null)
