import * as React from "react"

/**
 * Schema edits that cells can trigger on the property they show. Provided by
 * the database workspace; views without a provider (for example an embedded
 * view) simply do not offer them.
 */
export interface OptionActions {
  /**
   * Adds an option with this name to the property and resolves to its ID, or to
   * the ID of an existing option with the same name. Resolves to `null` when
   * the option could not be saved (the owner shows the error).
   */
  createOption: (propertyId: string, name: string) => Promise<string | null>
  /** Opens the options editor of the property. */
  editOptions: (propertyId: string) => void
}

const OptionActionsContext = React.createContext<OptionActions | null>(null)

export const OptionActionsProvider = OptionActionsContext.Provider

export function useOptionActions(): OptionActions | null {
  return React.useContext(OptionActionsContext)
}
