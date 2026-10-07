import * as React from "react"

export const InlinePickersContext = React.createContext(false)

/**
 * Inside a menu (the row menu's property page) a picker must not open as one more floating
 * surface over it: wrap the editors in this and their pickers unfold in place instead.
 */
export const InlinePickers = InlinePickersContext.Provider
