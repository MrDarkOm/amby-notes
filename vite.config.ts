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
  "vendor-codemirror-core": ["@codemirror/commands", "@codemirror/state", "@codemirror/view"],
  "vendor-codemirror-language": ["@codemirror/lang-markdown", "@codemirror/language"],
  "vendor-react": ["react", "react-dom", "scheduler"],
  "vendor-radix": ["@radix-ui"],
  "vendor-i18n": ["i18next", "react-i18next"],
  "vendor-state": ["zustand"],
  "vendor-ui": [
    "@tanstack/react-virtual",
    "class-variance-authority",
    "clsx",
    "cmdk",
    "lucide-react",
    "next-themes",
    "tailwind-merge",
  ],
  "vendor-markdown": ["markdown-it", "prosemirror-markdown"],
  "vendor-tauri": ["@tauri-apps/api"],
  "vendor-d3": ["d3-force"],
  "vendor-emoji-core": ["emoji-mart"],
  "vendor-emoji-data": ["@emoji-mart/data"],
}

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // Keep a useful warning threshold while allowing the deliberately split
    // rich-editor vendor chunks.
    chunkSizeWarningLimit: 1800,
    modulePreload: {
      filter(url) {
        if (
          url.includes("vendor-excalidraw") ||
          url.includes("vendor-xyflow") ||
          url.includes("sketch-editor") ||
          url.includes("canvas-editor")
        ) {
          return false
        }
        return true
      },
    },
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
      // Agent worktrees live inside the project folder: a build or a test run in one of
      // them must not reload the window of the application running from this checkout.
      // The folder is named from this checkout's own root: a worktree's path itself goes
      // through `.claude`, and a pattern matching it anywhere would stop the application
      // started from a worktree from seeing any change at all.
      ignored: ["**/src-tauri/**", `${path.resolve(import.meta.dirname, ".claude")}/**`],
    },
  },
}))
