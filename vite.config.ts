import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// @ts-expect-error process is a Node.js global
const host = process.env.TAURI_DEV_HOST

const vendorChunks: Record<string, string[]> = {
  "vendor-tiptap": [
    "@tiptap/core",
    "@tiptap/react",
    "@tiptap/starter-kit",
    "@tiptap/extension-image",
    "@tiptap/extension-placeholder",
    "@tiptap/extension-table",
    "@tiptap/extension-task-item",
    "@tiptap/extension-task-list",
    "@tiptap/suggestion",
    "@tiptap/extension-bubble-menu",
    "@tiptap/extension-link",
  ],
  "vendor-codemirror": [
    "@codemirror/commands",
    "@codemirror/lang-markdown",
    "@codemirror/language",
    "@codemirror/state",
    "@codemirror/view",
  ],
  "vendor-d3": ["d3-force"],
  "vendor-xyflow": ["@xyflow/react"],
  "vendor-emoji": ["emoji-mart", "@emoji-mart/react", "@emoji-mart/data"],
}

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [chunk, packages] of Object.entries(vendorChunks)) {
            if (packages.some((pkg) => id.includes(`/node_modules/${pkg}/`))) return chunk
          }
          return undefined
        },
      },
    },
  },
  clearScreen: false,
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
      ignored: ["**/src-tauri/**"],
    },
  },
}))
