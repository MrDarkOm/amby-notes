import * as React from "react"
import { Workspace } from "./components/workspace/workspace"
import { ExternalConflictDialog } from "./components/workspace/external-conflict-dialog"
import { ThemeProvider } from "./components/theme-provider"
import { TooltipProvider } from "./components/ui/tooltip-provider"
import {
  useApplyPreferences,
  useSettingsStore,
  useWindowStatePersistence,
} from "./components/workspace/use-settings-store"
import { StandaloneSettingsWindow } from "./components/workspace/settings-dialog"
import { MotionConfig } from "motion/react"
import { MotionPulse } from "./lib/motion"
import { motionTransitions } from "./lib/motion-config"
import { runAutomaticAppUpdate, type StartupUpdateResult } from "./lib/app-updater"

const isSettingsWindow = new URLSearchParams(window.location.search).get("ambyView") === "settings"

function PreferencesGate() {
  const preferencesReady = useApplyPreferences()
  const windowStateReady = useWindowStatePersistence(!isSettingsWindow)
  const autoUpdate = useSettingsStore((state) => state.prefs.updates.autoUpdate)
  const updateChannel = useSettingsStore((state) => state.prefs.updates.channel)
  const startupUpdateRef = React.useRef<Promise<StartupUpdateResult> | null>(null)
  const [startupUpdateReady, setStartupUpdateReady] = React.useState(isSettingsWindow)

  React.useEffect(() => {
    if (!preferencesReady || isSettingsWindow) return
    // Snapshot the hydrated preference once. Enabling automatic updates while
    // notes are open takes effect on the next launch, avoiding a surprise exit.
    startupUpdateRef.current ??= autoUpdate
      ? runAutomaticAppUpdate(updateChannel)
      : Promise.resolve("ready")
    let cancelled = false
    void startupUpdateRef.current.then((result) => {
      if (!cancelled && result === "ready") setStartupUpdateReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [autoUpdate, preferencesReady, updateChannel])

  if (!preferencesReady || !windowStateReady || !startupUpdateReady) {
    return (
      <main
        aria-busy="true"
        className="flex h-screen items-center justify-center bg-background text-muted-foreground"
        style={{ background: "hsl(var(--background, 220 20% 97%))" }}
      >
        <MotionPulse className="size-5 rounded-full bg-muted" />
      </main>
    )
  }
  if (isSettingsWindow) return <StandaloneSettingsWindow />
  return (
    <>
      <Workspace />
      <ExternalConflictDialog />
    </>
  )
}

export default function App() {
  React.useEffect(() => {
    const preventSystemContextMenu = (event: MouseEvent) => {
      event.preventDefault()
    }
    window.addEventListener("contextmenu", preventSystemContextMenu)
    return () => window.removeEventListener("contextmenu", preventSystemContextMenu)
  }, [])

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={true}>
      <MotionConfig reducedMotion="user" transition={motionTransitions.default}>
        <PreferencesGate />
        <TooltipProvider />
      </MotionConfig>
    </ThemeProvider>
  )
}
