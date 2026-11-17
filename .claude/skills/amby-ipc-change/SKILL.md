---
name: amby-ipc-change
description: Use in Amby Notes when adding, renaming, removing or changing a Tauri command, its arguments, return or error type, or any type that crosses Rust ↔ TypeScript (anything that ends up in src/lib/bindings.ts).
---

# Changing an IPC command in Amby

The rules live in [agent-guidelines.md](../../../docs/ai/agent-guidelines.md) ("Generated IPC
Bindings", "Security and Permissions") and [the storage map](../../../src/lib/storage/MAP.md).
This is the order of work and the traps that are easy to miss. If anything here disagrees with
those files, they win.

## Rust side

1. Put the command in `src-tauri/src/commands/<area>.rs` and the domain logic in its own
   module. `lib.rs` only registers.
2. Annotate with both `#[tauri::command]` and `#[specta::specta]`. Every type that crosses the
   boundary derives `specta::Type` (and serde).
3. Register it in `specta_builder()` → `collect_commands![...]` in `src-tauri/src/lib.rs`. That
   one list feeds both the invoke handler and the bindings. A command missing from it does not
   reach `bindings.ts` and cannot be called.
4. **Every window can call every app command.** There is no `src-tauri/permissions/` and no app
   manifest, so the capabilities in `src-tauri/capabilities/` restrict only core and plugin
   commands. The note and settings windows are not sandboxed for app commands. Each command
   must therefore validate its own input:
   - vault paths through `paths::guard` (canonical, inside the open vault);
   - external addresses through `parse_web_address` in `commands/external.rs` (http/https only);
   - openable files through the attachment allowlist in the same file.
     Never hand a raw frontend string to `std::process::Command`, `open`, `explorer` or
     `xdg-open`.
5. Errors cross the boundary as a stable machine code (`"OpenFolderFailed"`,
   `StorageOperationErrorCode`), never as `e.to_string()` meant for display. The frontend turns
   the code into localized text ([notice rules](../../../docs/notices.md) §10).
6. No `unwrap()`/`expect()` on data that comes from the frontend or the disk inside a command.
   Do not hold a `std::sync::Mutex` guard across `.await` or slow I/O.
7. A new plugin command, unlike an app command, needs an entry in each capability file of a
   window that uses it, and nowhere else.

## Bindings

8. Regenerate: `cargo test --manifest-path src-tauri/Cargo.toml export_bindings` (fast), then
   the full `npm run rust:test` before handing off. Check with `npm run bindings:check`.
   Never edit `src/lib/bindings.ts` by hand. Commit it in the same change.

## Frontend side

9. Only `src/lib/storage/` talks to `bindings.ts`. Call the generated `commands.*` in
   `desktop-adapter.ts` (or the domain repository / port that owns the area), add the method to
   `port.ts` / `types.ts`, and expose it through the repository. Components import from
   `@/lib/storage`, never from bindings.
10. Implement the browser adapter (`web-adapter-core.ts`) explicitly: real behaviour, or a
    clear `unsupported` result. Do not let it silently succeed.

## Before handing off

- `npm run rust:test`, `npm run typecheck`, `npm run build`; `npm run rust:clippy` for
  backend-heavy changes.
- IPC changes need targeted testing in `npm run dev` and `npm run tauri dev`.
- If the contract changed, update the nearest `MAP.md`, then run `npm run docs:check`, and
  add an entry to `updates/upd_next.md` (English).
