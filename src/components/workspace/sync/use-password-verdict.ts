import * as React from "react"

import type { PasswordCheck, SyncPort } from "@/lib/sync/sync-port"

interface Verdict {
  password: string
  check: PasswordCheck
}

/**
 * The verdict of the application on a password (docs/sync-plan.md, Р5). The application is the
 * judge, the screen only shows it. `check` is the verdict for the current text only and is the one
 * to decide with; `shown` is the last verdict received, kept on screen while the next one is on its
 * way so that the hint does not blink. Both are `null` for an empty password.
 */
export function usePasswordVerdict(
  port: SyncPort,
  password: string,
  username: string,
): { check: PasswordCheck | null; shown: PasswordCheck | null } {
  const [verdict, setVerdict] = React.useState<Verdict | null>(null)

  React.useEffect(() => {
    if (!password) return
    let stale = false
    port
      .checkPassword(password, username)
      .then((check) => {
        if (!stale) setVerdict({ password, check })
      })
      .catch(() => {
        if (!stale) setVerdict(null)
      })
    return () => {
      stale = true
    }
  }, [port, password, username])

  if (!password || !verdict) return { check: null, shown: null }
  return { check: verdict.password === password ? verdict.check : null, shown: verdict.check }
}
