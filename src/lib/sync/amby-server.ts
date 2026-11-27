/** The server run by Amby: the one place that knows its address. */
export const AMBY_SERVER_URL = "https://ambysync.omlet.space"

/** Is `url` (as the application keeps it) the Amby server? */
export function isAmbyServer(url: string | null | undefined): boolean {
  if (!url) return false
  const clean = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase()
  return clean(url) === clean(AMBY_SERVER_URL)
}
