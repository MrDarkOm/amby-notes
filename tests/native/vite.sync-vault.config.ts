import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// The page of the native check of the sync of a vault (scripts/run-native-sync-vault.mjs). It
// lives in its own output folder, so it never replaces the other native builds.
const root = path.resolve(import.meta.dirname, "../..")
export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: {
    outDir: ".release-evidence/native-sync-vault-dist",
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, "tests/native/sync-vault.html") },
  },
})
