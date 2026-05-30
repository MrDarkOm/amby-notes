import { Workspace } from "./components/workspace/workspace"
import { ThemeProvider } from "./components/theme-provider"
import { useApplyPreferences } from "./components/workspace/use-settings-store"

function PreferencesGate() {
  useApplyPreferences()
  return <Workspace />
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={true}>
      <PreferencesGate />
    </ThemeProvider>
  )
}
