import * as React from "react"

import type { PasswordCheck, SyncPort } from "@/lib/sync/sync-port"

interface Verdict {
  password: string
  check: PasswordCheck
}

/**
 * The verdict of the application on a password (docs/sync-plan.md, Р5). The application is the
 * judge, the screen only shows it; a verdict that belongs to an earlier text is never used.
 */
export function usePasswordVerdict(
  port: SyncPort,
  password: string,
  username: string,
): PasswordCheck | null {
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

  return verdict && verdict.password === password ? verdict.check : null
}
