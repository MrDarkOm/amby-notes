import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Tiptap + ProseMirror — the largest single block (~400 kB).
          "vendor-tiptap": [
            "@tiptap/core",
            "@tiptap/react",
            "@tiptap/starter-kit",
            "@tiptap/extension-bubble-menu",
            "@tiptap/extension-image",
            "@tiptap/extension-link",
            "@tiptap/extension-placeholder",
            "@tiptap/extension-table",
            "@tiptap/extension-table-cell",
            "@tiptap/extension-table-header",
            "@tiptap/extension-table-row",
            "@tiptap/extension-task-item",
            "@tiptap/extension-task-list",
            "@tiptap/suggestion",
          ],
          // CodeMirror — used only in source-mode view.
          "vendor-codemirror": [
            "@codemirror/commands",
            "@codemirror/lang-markdown",
            "@codemirror/language",
            "@codemirror/state",
            "@codemirror/view",
          ],
          // d3-force — used only in the graph tab.
          "vendor-d3": ["d3-force"],
          // @xyflow/react — used only in the canvas editor tab.
          "vendor-xyflow": ["@xyflow/react"],
          // emoji-mart — used only in the emoji picker panel.
          "vendor-emoji": ["emoji-mart", "@emoji-mart/react", "@emoji-mart/data"],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}))
