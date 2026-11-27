import { Play, RefreshCw, Settings2 } from "lucide-react"

/** The icon of each fixing action, shared with the right-click menu of the dock button. */
export const SYNC_ACTION_ICONS = {
  resume: Play,
  reconnect: RefreshCw,
  runNow: RefreshCw,
  refresh: RefreshCw,
  settings: Settings2,
} as const
