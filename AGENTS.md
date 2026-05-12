# Repository Guidelines

## Project Structure & Module Organization

This is a Tauri 2 desktop notes app with a React 19 + TypeScript + Vite frontend.

- `src/` contains the frontend application.
- `src/components/workspace/` holds app-specific workspace UI, editor, sidebar, tabs, search, tags, and panels.
- `src/components/ui/` contains reusable Radix/shadcn-style primitives.
- `src/lib/` contains shared utilities and storage abstractions.
- `src/hooks/` contains React hooks.
- `src-tauri/` contains the Rust Tauri shell, commands, permissions, icons, and Cargo files.
- `public/` stores static web assets; `dist/` is generated build output.

## Build, Test, and Development Commands

- `npm run dev` starts the Vite development server for browser-based UI work.
- `npm run build` runs TypeScript checking with `tsc` and builds the frontend with Vite.
- `npm run preview` serves the built frontend locally.
- `npm run tauri dev` runs the full desktop app through Tauri.
- `npm run tauri build` creates a production desktop bundle.
- `cd src-tauri && cargo check` validates Rust code quickly without producing an app bundle.

## Coding Style & Naming Conventions

Use TypeScript, React function components, and existing local component patterns. Keep workspace-specific components in `src/components/workspace/` and shared UI primitives in `src/components/ui/`. Use kebab-case filenames for components, for example `document-editor.tsx`, and PascalCase for exported React components. Prefer Tailwind utility classes and the existing `cn()` helper from `src/lib/utils.ts` for conditional class names. Keep Rust commands in `src-tauri/src/lib.rs` unless they grow large enough to justify modules.

## Testing Guidelines

There is currently no configured test runner or `npm test` script. For now, verify changes with `npm run build`, `cargo check`, and targeted manual testing in both `npm run dev` and `npm run tauri dev` when desktop behavior is affected. If adding tests, prefer colocated `*.test.tsx` or `*.test.ts` files near the code they cover and add the test command to `package.json`.

## Commit & Pull Request Guidelines

Recent commits use short conventional prefixes such as `feat:`, `fix:`, and `chore:`. Keep commit subjects imperative and specific, for example `fix: preserve tab state after reload`. Pull requests should include a concise summary, verification steps, linked issues when applicable, and screenshots or screen recordings for UI changes.

## Security & Configuration Tips

Keep Tauri permissions narrow in `src-tauri/capabilities/default.json`. Do not commit local vault data, generated bundles, or machine-specific files. Treat filesystem access changes as high-risk and test both browser fallback behavior and desktop Tauri commands.
