import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// The page of the native sync connect check (scripts/run-native-sync.mjs). It lives in its own
// output folder, so it never replaces the build of the storage contract.
const root = path.resolve(import.meta.dirname, "../..")
export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: {
    outDir: ".release-evidence/native-sync-dist",
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, "tests/native/sync-connect.html") },
  },
})
