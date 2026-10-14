import * as React from "react"

/** A titled block of the aside beside a page's text (the dossier's and the plot's). */
export function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** A quiet line where a block has nothing to show; blocks never vanish for being empty. */
export function QuietLine({ children }: { children: React.ReactNode }) {
  return <p className="px-2 text-xs text-muted-foreground">{children}</p>
}
