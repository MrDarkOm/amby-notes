import type * as React from "react"

interface PageHeaderProps {
  /** The page's glyph, already sized (28 px). */
  icon: React.ReactNode
  title: string
  /** What kind of page this is ("Story", "Universe"…): the first words of the quiet line. */
  kind: string
  /** The numbers of the page, after the kind; none hides them. */
  meta?: string | null
  tags?: readonly string[]
  /** Buttons at the right: only the ones that mean something on this page. */
  actions?: React.ReactNode
}

/**
 * The head of every creative page, one shape: a glyph, the name (a long one wraps), and a quiet
 * line with the kind and the numbers. The pages of a story, a universe, the standalone stories
 * and the workshop differ in what stands in `actions`, nothing else.
 */
export function PageHeader({
  icon,
  title,
  kind,
  meta = null,
  tags = [],
  actions,
}: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <h1 className="break-words text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{[kind, meta].filter(Boolean).join(" · ")}</span>
          {tags.map((tag) => (
            <span key={tag} className="rounded-full bg-accent px-2 py-0.5">
              {tag}
            </span>
          ))}
        </p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}
