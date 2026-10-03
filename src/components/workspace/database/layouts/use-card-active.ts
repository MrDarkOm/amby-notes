import * as React from "react"

/**
 * Whether the pointer is over a card or focus is inside it, with the props to put
 * on the card. Tracked here, not through the card's animation variants, so the
 * pencil's visibility never depends on how the card itself is animated.
 */
export function useCardActive() {
  const [hovered, setHovered] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  return {
    active: hovered || focused,
    activeProps: {
      onPointerEnter: () => setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocus: () => setFocused(true),
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      },
    },
  }
}
