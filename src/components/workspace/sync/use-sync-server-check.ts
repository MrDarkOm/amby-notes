import * as React from "react"
import { AMBY_SERVER_URL } from "@/lib/sync/amby-server"
import type { ServerCheck, SyncPort } from "@/lib/sync/sync-port"

interface CheckedServer {
  key: string
  server: ServerCheck | null
  error: unknown
  checking: boolean
}

/** Public server metadata only: no credentials, and no stale response can authorize a new URL. */
export function useSyncServerCheck(
  port: SyncPort,
  url: string,
  allowHttp: boolean,
  enabled: boolean,
) {
  const address = url.trim()
  const key = JSON.stringify([address, allowHttp])
  const [checked, setChecked] = React.useState<CheckedServer>({
    key: "",
    server: null,
    error: null,
    checking: false,
  })
  React.useEffect(() => {
    if (!enabled) return
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delay: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => void check(), delay)
    }
    const check = async () => {
      if (disposed || inFlight || !address) return
      inFlight = true
      setChecked((previous) => ({
        key,
        server: previous.key === key ? previous.server : null,
        error: null,
        checking: true,
      }))
      let succeeded = false
      try {
        const server = await port.checkServer({ url: address, allowHttp })
        if (disposed) return
        succeeded = true
        setChecked({ key, server, error: null, checking: false })
      } catch (error) {
        if (!disposed) setChecked({ key, server: null, error, checking: false })
      } finally {
        inFlight = false
        if (!disposed) schedule(succeeded ? 30_000 : 10_000)
      }
    }
    const refresh = () => {
      if (!inFlight) schedule(0)
    }
    if (address) schedule(address === AMBY_SERVER_URL ? 0 : 300)
    window.addEventListener("online", refresh)
    window.addEventListener("focus", refresh)
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener("online", refresh)
      window.removeEventListener("focus", refresh)
    }
  }, [port, key, address, allowHttp, enabled])

  const current = checked.key === key ? checked : null
  return {
    server: current?.server ?? null,
    error: current?.error ?? null,
    checking: Boolean(address) && (!current || current.checking),
    ready: Boolean(current?.server) && !current?.error,
  }
}
