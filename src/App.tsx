import { Workspace } from "./components/workspace/workspace"
import { ExternalConflictDialog } from "./components/workspace/external-conflict-dialog"
import { ThemeProvider } from "./components/theme-provider"
import { TooltipProvider } from "./components/ui/tooltip-provider"
import { useApplyPreferences } from "./components/workspace/use-settings-store"
import { StandaloneSettingsWindow } from "./components/workspace/settings-dialog"

const isSettingsWindow = new URLSearchParams(window.location.search).get("ambyView") === "settings"

function PreferencesGate() {
  const preferencesReady = useApplyPreferences()
  if (!preferencesReady) {
    return (
      <main
        aria-busy="true"
        className="flex h-screen items-center justify-center bg-background text-muted-foreground"
        style={{ background: "hsl(var(--background, 220 20% 97%))" }}
      >
        <div className="size-5 animate-pulse rounded-full bg-muted" />
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
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={true}>
      <PreferencesGate />
      <TooltipProvider />
    </ThemeProvider>
  )
}
