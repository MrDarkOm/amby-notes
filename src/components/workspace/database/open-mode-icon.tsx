import { cn } from "@/lib/utils"

/**
 * How a row opens, drawn as the window it opens in: a panel on the right (side peek), a card in
 * the middle (center peek) or the whole page. The page part is tinted, the window outline is not.
 */
export function OpenModeIcon({ mode, className }: { mode: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    >
      <rect x="1.65" y="2.65" width="12.7" height="10.7" rx="2" />
      {mode === "centerPeek" ? (
        <rect x="4.3" y="5" width="7.4" height="6" rx="1" fill="currentColor" fillOpacity="0.45" />
      ) : mode === "fullPage" ? (
        <rect
          x="3.6"
          y="4.6"
          width="8.8"
          height="6.8"
          rx="0.8"
          fill="currentColor"
          fillOpacity="0.45"
        />
      ) : (
        <path
          d="M9.4 2.9h2.7a1.9 1.9 0 0 1 1.9 1.9v6.4a1.9 1.9 0 0 1-1.9 1.9H9.4z"
          fill="currentColor"
          fillOpacity="0.45"
        />
      )}
    </svg>
  )
}
