import { Workspace } from "./components/workspace/workspace"
import { ExternalConflictDialog } from "./components/workspace/external-conflict-dialog"
import { ThemeProvider } from "./components/theme-provider"
import { TooltipProvider } from "./components/ui/tooltip-provider"
import { useApplyPreferences } from "./components/workspace/use-settings-store"

function PreferencesGate() {
  useApplyPreferences()
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
