import { defineConfig } from "vite"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../..")
export default defineConfig({
  root,
  resolve: { alias: { "@": path.join(root, "src") } },
  build: {
    outDir: ".release-evidence/native-dist",
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, "tests/native/index.html") },
  },
})
