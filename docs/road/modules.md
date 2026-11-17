# Modules and plugins: plans and audits

Status as of 2026-11-03. The built-in `ModuleHost`, registries and the package manager (Rust, Ed25519 signing) are implemented; execution of installed modules is turned off by a switch, and third-party plugins are not used. Replacing the leaked signing key is a mandatory condition for turning them on: [target/safety-and-platforms.md](target/safety-and-platforms.md).

| Part                         | What                                 | Status              |
| ---------------------------- | ------------------------------------ | ------------------- |
| 1. Modular architecture plan | Modules, plugins, profiles, packages | current scheme      |
| 2. Inventory (MOD-00)        | Codebase snapshot at 0.1.4           | historical snapshot |
| 3. Independent audit         | Snapshot at 0.1.5                    | not re-verified     |

---

## Part 1. Amby modular architecture plan after 0.1.4

_Formerly the file `modular-architecture-0.1.5-plan.md`, merged 2026-11-03._

> **Status as of 2026-11-02:** the current architectural scheme for future modules and plugins. The built-in `ModuleHost`, registries and the package manager (Rust, Ed25519 signing) are implemented; community plugins are deferred. The code refers to this document from `src/lib/modules/types.ts`.

### 1. Decision and goal

Amby must remain a lightweight local app for reading and editing Markdown. The user installs additional capabilities globally and enables them separately for each space.

The product uses two terms:

- **Modules** — official Amby extensions, signed and published by the project team.
- **Plugins** — community extensions that run in a restricted environment with explicitly granted permissions.

Canvas remains an ordinary official module. It is not considered obsolete or archived. The base distribution does not have to contain its code, but the user can install Canvas and enable it in the spaces they need.

The target model:

1. The app installs a minimal core.
2. The first-launch profile determines the initial set of modules.
3. A module package is installed once for the whole app.
4. Each space keeps its own list of enabled modules and their settings.
5. Disabling or removing a module does not delete user documents.
6. Markdown, attachments, `.canvas`, `.excalidraw` and other user files remain the user's property.

This plan is meant for development after the `0.1.4` release. The database fixes left over after the separate audit belong to `0.1.5` and must be completed before the database is moved into a physically detachable module.

### 2. First-launch profiles

A profile is used as the starting configuration of a new space. After the space is created, the user can change the set of modules regardless of the chosen profile.

#### 2.1. Minimal

The profile provides:

- opening a local space;
- the tree of files and folders;
- tabs;
- reading Markdown;
- the Markdown editor in Source and the safe Live Preview;
- basic search by names and contents;
- app and space settings;
- import, export and ordinary file operations;
- the mandatory data-safety mechanisms.

The profile does not load feature modules. The user-facing version history is also not part of the core.

The core must nevertheless preserve:

- atomic file writes;
- serialization of autosave for a single file;
- protection against external-change conflicts;
- temporary drafts for recovery after a crash;
- safe deletion into the space's trash;
- boundary checks of the chosen vault.

These are data-safety mechanisms, not the user-facing "History" feature.

#### 2.2. Standard

When this profile is chosen, Amby downloads and enables a set of official modules defined by the product owner. The set is published as a signed, versioned catalog profile.

Requirements:

- the profile's contents can be changed on the catalog server without releasing a new core version;
- a new space receives a snapshot of the current profile contents;
- later changes to the profile must not arbitrarily enable or remove modules in an already configured space;
- before downloading, the total size, permissions and dependencies are shown;
- when there is no network, space creation is not blocked: Amby creates a minimal space and offers to download the missing modules later.

The exact profile contents are fixed by a separate product decision before the catalog launches. Until then the assumption "all ready modules" must not be hardcoded.

#### 2.3. Custom

The user chooses the modules themselves before creating the space.

For each module the selection screen shows:

- its purpose;
- download size and size after installation;
- required permissions;
- dependencies;
- compatibility with the current Amby version;
- installation status;
- the publisher and the signature state.

Downloading the chosen set is done transactionally: the space is created even if one package fails, and the interface clearly shows which modules could not be installed or enabled.

### 3. Boundary of the minimal core

The core keeps only what Amby cannot safely open a space and save Markdown without:

- Tauri startup, windows and basic navigation;
- selecting and canonicalizing the space path;
- a safe file gateway and narrow IPC commands;
- the file tree, tabs and the basic model of open documents;
- the Markdown Source Editor;
- Live Preview only for byte-exact Markdown;
- basic file and folder operations;
- basic search;
- settings, localization and core themes;
- emergency recovery of unwritten text;
- atomic writes, CAS checks, external-change conflicts and the trash;
- the module loader, the contribution registry, permissions, safe mode and diagnostics.

Domain-specific functions move into official modules:

- Excalidraw;
- Canvas;
- Version history;
- Databases;
- Tags;
- Favorites;
- Backlinks and related notes;
- Graph;
- Sync;
- AI;
- other large features according to the results of the inventory.

The core must not be split so far that ordinary Markdown editing depends on a network or a module.

### 4. Two independent module states

The concepts "installed" and "enabled" must be separated.

#### 4.1. Global installation

The global registry is stored in the app's data directory. An example structure:

```text
Amby/
  modules.json
  module-catalog.json
  modules/
    amby.excalidraw/
      1.0.0/
        manifest.json
        index.js
        style.css
        assets/
        module.wasm
```

`modules.json` stores the installed versions, the active version, the signature state, the source and the time of the last successful launch. The package catalog is cached separately and is not a source of user data.

#### 4.2. Enabling in a space

`.amby/workspace.json` stores only the configuration of the current space:

```json
{
  "profile": {
    "id": "standard",
    "catalogRevision": "2026-09-20"
  },
  "enabledModules": ["amby.excalidraw", "amby.tags"],
  "moduleSettings": {
    "amby.excalidraw": {}
  }
}
```

Rules:

- one installed module can be enabled in space A and disabled in space B;
- switching the space stops the watchers, background tasks and commands of the previous space's modules;
- module settings are local to the space by default;
- truly global preferences must be declared explicitly in the manifest;
- the placement of panels does not determine whether a module is enabled;
- removing a panel from the layout does not disable the module;
- enabling a module does not have to open its panel automatically.

The current combination of `activeModules`, presets and `panelScope` must be migrated into independent entities: profile, installation state, space state and layout.

### 5. Package format and manifest

The minimal manifest:

```json
{
  "formatVersion": 1,
  "id": "amby.canvas",
  "name": "Canvas",
  "version": "1.0.0",
  "publisher": "Amby",
  "kind": "official",
  "minAppVersion": "0.1.5",
  "entry": "index.js",
  "style": "style.css",
  "permissions": ["vault.read", "vault.write", "workspace.tabs"],
  "dependencies": {},
  "contributions": {
    "fileHandlers": ["canvas"],
    "commands": [],
    "panels": [],
    "settings": true,
    "translations": ["ru", "en"]
  },
  "data": {
    "namespace": ".amby/modules/amby.canvas",
    "uninstallPolicy": "preserve"
  },
  "checksums": {},
  "signature": {}
}
```

Required properties of the contract:

- a stable identifier independent of the display name;
- the semantic version of the package;
- the minimum and, if needed, maximum version of the core API;
- the list of permissions and dependencies;
- a declarative list of interface contributions;
- checksums of every file;
- the package signature;
- the data space and the removal policy;
- the settings schema and the data migration version;
- localizations without changing the core string registry at run time;
- theme tokens instead of arbitrary global CSS.

### 6. Module Host and the contribution API

The core provides a restricted SDK and contribution registries. A module must not import another module's internal components or access Zustand stores directly.

The registries needed:

- file type handlers;
- editors and document layers;
- side panels;
- commands and keyboard shortcuts;
- menu and toolbar items;
- settings;
- import and export;
- search providers;
- localizations;
- theme tokens;
- background tasks with a managed lifecycle.

The SDK must provide stable operations:

- open a document or a tab;
- obtain a document snapshot through a verified API;
- request reading or writing a file with permission checks;
- create a file without overwriting;
- subscribe to space events;
- register a command or an interface contribution;
- show a standard dialog, notification or note picker;
- save data in its own namespace;
- finish work and release resources.

Before the physical split, shared components must be moved out of the feature folders into a neutral SDK/UI. In particular, Excalidraw currently uses Canvas elements: the panel button, the note picker and path conversion. These dependencies must become shared components so that Excalidraw works without Canvas installed.

### 7. Permissions and isolation

The current permission list in the static registry is informational. The target system must check permissions at the moment of every sensitive call.

The minimal set of capabilities:

- `vault.read`;
- `vault.write`;
- `vault.watch`;
- `workspace.tabs`;
- `workspace.commands`;
- `network` with a domain allowlist;
- `clipboard.read` and `clipboard.write` separately;
- `external.open`;
- `secrets.use` without handing out the secret itself;
- `background.run`.

Rules:

- a path is always canonicalized and checked against the current space;
- a module gets no direct access to Tauri `invoke`, the file system or the keychain;
- permissions are granted to a specific module and space;
- extending the permission list on update requires new consent;
- a permission denial must be a normal result of the API;
- safe mode starts Amby without third-party plugins and with the ability to disable a problematic official module;
- repeated crashes automatically put the package into quarantine, but do not delete its data.

Official modules are signed by Amby, but they also go through permissions. The signature confirms origin and does not grant unlimited access.

### 8. Modules and plugins on macOS

For loadable packages, the main mechanism must not be built on unsigned `.dylib`, DLL or executable files. This would complicate notarization, updates and security.

The preferred model:

- the interface is JavaScript/CSS loaded by a controlled host;
- computational parts are WASM without WASI by default;
- access to the system is only through RPC to the core;
- official packages are signed by Amby, with a catalog that verifies integrity;
- community plugins run in a separate sandbox, for example an iframe/WebView/Worker, plus the same capability APIs;
- native capabilities are only as pre-shipped core providers or separately signed components with their own release process.

Direct signed distribution of Amby suits this model best. Compatibility with Mac App Store requirements must be checked separately before choosing the catalog distribution channel.

### 9. Lifecycle

#### 9.1. Installation

1. Download the package into a temporary directory.
2. Check the manifest format and API compatibility.
3. Check the signature and checksums.
4. Reject absolute paths, `..`, symbolic links pointing outside, and duplicate archive entries.
5. Check dependencies and the size after unpacking.
6. Unpack into staging.
7. Publish the version atomically.
8. Only after success, change the global registry.

An incomplete installation must not be visible as an installed module.

#### 9.2. Update

The new version is installed next to the old one. After verification, Amby switches the active version atomically. If activation or migration fails, the app returns to the previous version and saves a diagnostic report.

#### 9.3. Disabling

Before disabling, the host:

1. blocks new actions of the module;
2. requests a flush of open documents;
3. does not continue if there is an unresolved conflict or a save error;
4. closes the views that belong to the module, or shows a safe read-only state;
5. cancels background tasks and watchers;
6. removes command and UI registrations;
7. unloads the runtime.

#### 9.4. Removal

Removal deletes the package code and the clearable cache. User documents, space settings and data in `.amby/modules/<id>/` are kept by default. They can be cleared only by a separate explicit action that lists the data to be deleted.

If the module is enabled in at least one space, the manager first shows those spaces and offers to disable the module. Silent loss of functionality is unacceptable.

### 10. Behavior of files without a module

The core must keep showing all user files in the tree.

If the type handler is not installed:

- the file is not indexed as a supported module format;
- the file is not modified or deleted;
- the tab shows a safe view of the source text or a screen «Для этого файла нужен модуль» (A module is required for this file);
- the screen offers to install the official module if it is available in the catalog;
- the usual rename, move, export and delete operations stay available through the safe core;
- installing a module must not automatically rewrite an existing file.

For `.canvas` this means the file is fully preserved without Canvas. After the module is installed and enabled, the full Canvas editor is registered.

### 11. Migrating existing features

#### 11.1. Excalidraw

Excalidraw should become the first physically separable official module. It is already a large dependency and will give a measurable result in the size of the minimal build.

Before separation:

- move adding a note card and picking a note into Excalidraw;
- keep opening linked notes;
- extract shared UI components and path functions from `canvas/`;
- remove all Excalidraw imports from the Canvas implementation;
- define a stable Excalidraw file format and the behavior without the module;
- move the heavy frontend chunk out of the minimal distribution.

Criterion: Excalidraw installs and works with Canvas completely absent.

#### 11.2. Canvas

Canvas is a separate official module with its own `.canvas` handler, editor, commands and settings.

Criteria:

- Canvas can be installed globally;
- it can be enabled in just one space;
- disabling closes its runtime without losing unsaved data;
- removing the package does not delete `.canvas` files;
- reinstalling opens the existing `.canvas` files again without migrating their contents;
- Canvas and Excalidraw do not depend on each other.

#### 11.3. History

The following move to the official "History" module:

- user version snapshots;
- viewing and comparing versions;
- restoring a selected version;
- the snapshot retention and cleanup policy;
- the history panel.

The core keeps emergency recovery drafts, atomic write, and revision and conflict checks. While the module is disabled, the core must not create user history snapshots.

Before separation, the current Rust code in `history.rs` must be split into the core's data-safety API and a user-history provider.

#### 11.4. Databases

The migration starts only after the `0.1.5` stabilization tasks are complete and the data-safety checks have been passed again.

Recommended order:

1. Separate the UI registration and the `.ambd` handlers from the workspace.
2. Move the database frontend into a loadable package.
3. Keep the Rust implementation as a disabled core provider at the first stage if its physical separation creates a risk for data.
4. Measure the provider's contribution to binary size and memory.
5. After the measurements, choose between WASM, a signed sidecar, or a stable core provider API.
6. Only after that, physically separate the backend.

Size must never be bought by weakening transactionality, path control, migrations, backups and rollback.

#### 11.5. Other features

Tags, favorites, links, graph, sync and AI are migrated after the host API stabilizes. Features with large dependencies and a clear data boundary are separated first. For each feature, measure size, startup time, memory, background processes and ties to the core.

### 12. Implementation stages

Each stage ends with a separate verifiable result. The next stage does not start until the exit criteria of the previous one are met.

#### MOD-00. Inventory and baseline measurements

**When:** the first stage after the `0.1.4` release is complete.

**Do:**

- build a map of features, frontend chunks, Rust modules, IPC commands, permissions and background tasks;
- record the dependencies between the current modules;
- measure the installer size, the `app`/binary size, frontend assets, cold start and memory;
- measure Excalidraw, Canvas, databases and history separately;
- describe the minimal user scenario without modules;
- agree on the list of core features.

**Result:** a table of size and dependencies, an approved core boundary, a list of candidates for separation.

#### MOD-01. Separating installation, enablement, profile and layout

**When:** after MOD-00, before the package loader.

**Do:**

- introduce a global registry of installed packages;
- store `enabledModules` at the space level;
- decouple module state from panels and `panelScope`;
- turn the current presets into initial-configuration profiles;
- add a versioned and idempotent migration of the current settings;
- make a backup of the mutable configuration;
- document the rollback.

**Result:** an existing built-in module can be independently enabled in one space and disabled in another while its code still ships with the app.

#### MOD-02. Module Host and the contributions API

**When:** after the state model stabilizes.

**Do:**

- define the SDK version;
- implement the registries of files, editors, panels, commands and settings;
- introduce the activate/deactivate/dispose lifecycle;
- add a capability broker;
- add safe mode and quarantine;
- move at least one small built-in module to the new API without physical downloading.

**Result:** the workspace no longer contains special branches for the pilot module, and the host correctly releases its resources.

#### MOD-03. First-run profiles

**When:** once a stable host API exists.

**Do:**

- implement the profiles «Минимум» (Minimum), «Стандарт» (Standard) and «Кастомный» (Custom);
- store a signed, versioned «Стандарт» profile;
- show size, permissions and dependencies;
- provide an offline fallback;
- save a snapshot of the profile in the new space;
- rule out automatic changes to spaces that were already created.

**Result:** «Минимум» is created without downloads, «Стандарт» gets the set chosen by the product owner, «Кастомный» installs the user's selection.

#### MOD-04. Official module manager

**When:** after MOD-02 and MOD-03.

**Do:**

- implement the package format and the catalog;
- add signatures, checksums, staging and atomic publication;
- add install, update, rollback, disable and remove;
- implement dependencies and API compatibility;
- show the occupied size and the spaces where the module is enabled;
- add diagnostics for load errors.

**Result:** a test official module installs, updates, rolls back and is removed without changing user files.

#### MOD-05. Separating Excalidraw

**When:** the first large module, once the manager is ready.

**Do:**

- finish moving cards and notes into Excalidraw;
- extract shared components from Canvas;
- register the format, tabs, commands and settings through the host;
- build Excalidraw into a separate signed package;
- remove its heavy dependencies from the minimal distribution;
- verify it works with existing files.

**Result:** the minimal installation does not contain the Excalidraw runtime; installing the module brings back the whole feature; Canvas is not required.

#### MOD-06. Separating Canvas

**When:** after the Excalidraw pilot succeeds.

**Do:**

- move Canvas to the same SDK;
- remove the special Canvas branches from the workspace;
- register `.canvas` through a file handler;
- keep the safe behavior of the file without the module;
- verify disabling with an open, modified document.

**Result:** Canvas is an ordinary installable official module and does not affect the size of the «Минимум» profile.

#### MOD-07. Separating history

**When:** after the lifecycle is confirmed on editor modules.

**Do:**

- separate crash recovery from user versions;
- create a provider API for snapshots;
- move the panel, commands, retention and restore into the module;
- stop creating snapshots while the module is disabled;
- keep the core's recovery drafts and conflicts.

**Result:** the «Минимум» profile does not create version history, but safely restores unsaved text after a crash.

#### MOD-08. Databases and the remaining official modules

**When:** after the database tasks of `0.1.5` are closed and a repeat audit is done.

**Do:**

- separate the frontend and registrations first;
- introduce a backend provider boundary;
- measure the effect of physically removing the Rust code;
- choose the backend packaging based on the measurements;
- migrate tags, favorites, links, graph, sync and AI one by one;
- repeat the Minimum measurements after each migration.

**Result:** all declared official features are managed by a single manager and do not run code in a space where they are disabled.

#### MOD-09. Community plugins

**When:** only after the official SDK has stabilized on at least two large modules.

**Do:**

- define a separate `kind: community`;
- introduce a sandbox and RPC;
- add granting and revoking of permissions per space;
- forbid direct `invoke`, the Node API, the raw filesystem and the keychain;
- add a check of updated permissions;
- implement a crash report, quarantine and safe mode;
- prepare the catalog rules and a mechanism for revoking a malicious version.

**Result:** a third-party test plugin cannot go beyond the permitted APIs even with a deliberate attempt.

#### MOD-10. Acceptance and release

**When:** after the set of modules chosen for the release is complete.

**Do:**

- compare the final metrics with MOD-00;
- verify updating an existing installation;
- verify the new profiles online and offline;
- verify package rollback and safe mode;
- verify signing and notarization of the macOS build;
- update the user documentation;
- run a separate audit of data safety and permission boundaries.

**Result:** a measurable reduction of the «Минимум» profile and no regressions in the safety of user files.

### 13. Mandatory verification scenarios

Before the release, at least the following scenarios must pass:

1. A clean install creates the «Минимум» profile without a network.
2. «Стандарт» downloads the pinned set and does not change it arbitrarily later.
3. One globally installed module is enabled in space A and disabled in B.
4. Switching spaces leaves no watchers or background tasks of the old space.
5. Disabling a module with a dirty document does not lose changes.
6. Removing Canvas preserves all `.canvas` files byte for byte.
7. Reinstalling Canvas opens the former files.
8. Excalidraw creates a note card and opens the note without Canvas.
9. With history disabled, no user snapshots are created, but crash recovery works.
10. A package with an invalid signature or checksum is rejected before publication.
11. An archive with path traversal or an outward link is rejected.
12. A new version with an additional permission is not activated without consent.
13. A module crash does not close the app and does not corrupt a document.
14. A forbidden call from a community plugin is blocked by the capability broker.
15. An app update preserves globally installed packages and space settings.
16. Rolling back a module restores the previous working version without rolling back user files.
17. A file of an unknown type stays visible, movable and exportable.
18. The minimal build does not contain the frontend chunks of the physically separated modules.

Automated checks include unit, integration and Rust tests of the package format, paths, signature, migration and rollback. Manual checks are needed for installation, switching spaces, dirty documents, offline mode, the macOS bundle and recovery after a crash.

### 14. Key points of the current code

At the start of the work, take into account:

- `src/components/workspace/modules.ts` — the static registry and the current advisory permissions;
- `src/components/workspace/presets.ts` — the current presets and the composition of `activeModules`;
- `src/components/workspace/use-presets.ts` — the link between modules, layout and the settings scope;
- `src/components/workspace/app-config.ts` — global and local configuration;
- `src-tauri/src/app_data.rs` — the app data and space directories;
- `src/components/workspace/canvas/` — the Canvas implementation and shared elements that need to be decoupled;
- `src/components/workspace/sketch-editor.tsx` — Excalidraw and the current imports from Canvas;
- `src/components/workspace/use-layers.ts` — special branches for document types;
- `src/components/workspace/document-actions.tsx` — actions tied to specific formats;
- `src-tauri/src/history.rs` — user history and the parts that need to be separated from recovery;
- the frontend and Rust parts of databases — to be migrated after `0.1.5` stabilizes.

The list is refined in MOD-00. It is not permission for a mass refactoring of all files in a single change.

### 15. Implementation constraints

- Do not load executable code without verifying its signature and integrity.
- Do not give modules direct access to the filesystem, Tauri IPC and secrets.
- Do not tie enabling a module to panel visibility.
- Do not delete documents and settings when deleting module code.
- Do not change user formats just for the sake of packaging.
- Do not make the network mandatory for the «Минимум» profile.
- Do not migrate databases until the data-safety audit findings are closed.
- Do not open the SDK to the community until it has stabilized on the official modules.
- Do not treat a signature as a replacement for permissions and the sandbox.
- Do not promise a size reduction without measurements before and after each stage.

### 16. Program completion criterion

The architecture is considered implemented when:

- the «Минимум» profile contains only the Markdown core and the data-safety mechanisms;
- official modules are installed globally and enabled per space;
- Canvas, Excalidraw and History are physically absent from the minimal distribution and available through the manager;
- databases use the same lifecycle and retain all data guarantees;
- community plugins run in a sandbox through a stable capability API;
- removing any package preserves user files;
- the size, startup and memory of «Минимум» are improved and confirmed by measurements;
- updating from an old version goes through a versioned migration with a backup, a result log and a documented rollback.

---

## Part 2. Amby inventory and baseline measurements (MOD-00)

_Formerly the file `modular-architecture-inventory.md`, merged 2026-11-03._

> **Status as of 2026-11-02:** the inventory as of 0.1.5; file locations may have changed — check against the maps.

This document records the results of the Amby 0.1.4 codebase inventory before the move to the modular architecture of 0.1.5 according to the plan `docs/road/modular-architecture-0.1.5-plan.md`.

### 1. Map of functional blocks and dependencies

| Block                        | Location (Frontend / Backend)                                                                                                                                 | External dependencies                            | Status in the target architecture                                                |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------- | :------------------------------------------------------------------------------- |
| **Markdown core**            | `src/components/workspace/document-editor.tsx`, `src/components/workspace/tiptap/`, `src/components/workspace/codemirror/`, `src-tauri/src/commands/notes.rs` | Tiptap, ProseMirror, CodeMirror                  | **Core** (Minimum)                                                               |
| **Vault and data safety**    | `src/lib/storage.ts`, `src/components/workspace/autosave/`, `src-tauri/src/frontmatter.rs`, `src-tauri/src/recovery.rs`                                       | Tauri IPC, FS                                    | **Core** (atomic write, CAS, recovery drafts, trash)                             |
| **File tree and navigation** | `src/components/workspace/tree/`, `src/components/workspace/tabs/`, `src-tauri/src/commands/vault.rs`                                                         | Radix UI, Lucide                                 | **Core**                                                                         |
| **Basic search**             | `src/components/workspace/spotlight/`, `src-tauri/src/commands/notes.rs`                                                                                      | SQLite FTS5                                      | **Core**                                                                         |
| **Excalidraw (Sketches)**    | `src/components/workspace/sketch/`, `src/lib/sketch-format.ts`, `src-tauri/src/commands/mutations.rs`                                                         | `@excalidraw/excalidraw` (3.9 MB JS, 195 KB CSS) | **Official module** (`amby.excalidraw`). First candidate for physical separation |
| **Canvas**                   | `src/components/workspace/canvas/`, `src-tauri/src/commands/mutations.rs`                                                                                     | `@xyflow/react` (169 KB JS)                      | **Official module** (`amby.canvas`)                                              |
| **Version history**          | `src/components/workspace/history/`, `src-tauri/src/history.rs`                                                                                               | SQLite snapshots                                 | **Official module** (`amby.history`). Separated from crash recovery              |
| **Databases**                | `src/components/workspace/database/`, `src-tauri/src/database/`                                                                                               | SQLite, TanStack Virtual                         | **Official module** (`amby.databases`). Migration after 0.1.5 stabilizes         |
| **Graph**                    | `src/components/workspace/graph/`                                                                                                                             | `cytoscape` (425 KB JS)                          | **Official module** (`amby.graph`)                                               |
| **Tags**                     | `src/components/workspace/tags/`, `src-tauri/src/commands/notes.rs`                                                                                           | SQLite index                                     | **Official module** (`amby.tags`)                                                |
| **Favorites**                | `src/components/workspace/favorites/`                                                                                                                         | `session.json`                                   | **Official module** (`amby.favorites`)                                           |
| **Backlinks**                | `src/components/workspace/links/`                                                                                                                             | SQLite link graph                                | **Official module** (`amby.links`)                                               |
| **AI**                       | `src/components/workspace/ai/`, `src-tauri/src/ai.rs`, `src-tauri/src/credentials.rs`                                                                         | Ollama/OpenAI/Anthropic APIs, OS Keychain        | **Official module** (`amby.ai`)                                                  |
| **Sync**                     | `src/components/workspace/sync/` (in development)                                                                                                             | —                                                | **Official module** (`amby.sync`, status `preview`)                              |

---

### 2. Analysis of coupling and parasitic dependencies

1. **Excalidraw ⟷ Canvas**:
   - `src/components/workspace/sketch/sketch-editor.tsx` imported `ToolbarButton` from `canvas/canvas-toolbar.tsx`.
   - `sketch-editor.tsx` imported `CanvasNotePickerModal` from `canvas/canvas-note-picker-modal.tsx`.
   - `sketch-editor.tsx` imported `toRelativeVaultPath` from `canvas/canvas-markdown.ts`.
   - _Resolution in MOD-01_: move these components into the neutral modules `src/components/workspace/common/` and `src/lib/paths.ts` so that Excalidraw is fully autonomous without Canvas installed.

2. **Version history ⟷ Crash Recovery**:
   - `src-tauri/src/history.rs` and `src-tauri/src/commands/history.rs` mix the functions of user snapshots (snapshots, retention, cleanup) with the critical data-safety mechanisms of the core (`save_recovery`, `read_recovery`, `delete_recovery`, `list_recovery`, `list_trash`, `restore_trash`).
   - _Resolution for MOD-07_: a split at the Rust level — emergency recovery drafts and the trash stay in the core (`recovery.rs`, `recycle_bin.rs`), while user version snapshots move to the provider of the `amby.history` module.

3. **Databases ⟷ Workspace**:
   - Handling of `.ambd` files and creation of database rows have direct branches in `use-layers.ts` and `workspace-orchestration.tsx`.
   - _Resolution for MOD-08_: a transition through the `FileHandler` and `DocumentLayer` abstractions in the Module Host API.

---

### 3. Baseline measurements (Baseline Metrics — 0.1.4)

#### 3.1. Frontend Chunks (`dist/`)

- Total size of the `dist/` folder: **12 MB**
- Largest vendor chunks:
  - `vendor-excalidraw`: **4,054 KB JS** (1,408 KB gzip) + **195 KB CSS** (~35% of the entire frontend!)
  - `index-*.js` (main app): **890 KB** (246 KB gzip)
  - `chunk-FOHPRMQF-*.js` (shared icons/ui): **647 KB** (143 KB gzip)
  - `vendor-ui`: **559 KB** (152 KB gzip)
  - `cytoscape.esm`: **425 KB** (138 KB gzip) (Graph module)
  - `vendor-emoji-data`: **419 KB** (82 KB gzip)
  - `vendor-tiptap`: **408 KB** (131 KB gzip)
  - `vendor-codemirror-core` + `vendor-codemirror-language`: **486 KB** (174 KB gzip)
  - `katex`: **253 KB** (77 KB gzip)
  - `document-editor`: **246 KB** (69 KB gzip)
  - `vendor-xyflow`: **169 KB** (56 KB gzip) (Canvas module)

#### 3.2. Rust Backend

- Number of IPC commands in `src-tauri/src/lib.rs`: **75 commands**
- Compile time (`dev` profile, warm cache): **~4.3s**
- Modules in `src-tauri/src/`: 20 modules (`ai`, `app_data`, `bundle`, `commands`, `credentials`, `database`, `frontmatter`, `history`, `index`, `model`, `paths`, `property_store`, `recovery`, `recycle_bin`, `state`, `system_recycle_bin`, `vault`, `vault_context`, `vault_index`, `watcher`).

#### 3.3. Tests

- Frontend tests: **107 files, 663 tests** (run time ~4.1s)

---

### 4. Boundary of the minimal core (Target Minimal Core)

The minimal Amby build with no modules installed keeps:

1. Tauri startup, the main window, the macOS/Windows menus, path canonicalization.
2. The file explorer (tree, create, rename, delete to trash, move).
3. Tabs and the document buffer model.
4. The Markdown editors: Source (CodeMirror) and Live Preview (Tiptap).
5. Data-safety mechanisms: atomic write, CAS, protection against overwriting external changes, recovery drafts, `.amby/trash/`.
6. Basic search by note names and text.
7. App settings, theme and language switching.
8. The module subsystem: Module Host, the registry of installed packages, capability broker, safe mode.

All other features (Excalidraw, Canvas, Databases, History, Graph, Tags, Favorites, Links, AI, Sync) are modules with an independent lifecycle.

---

## Part 3. Independent audit of the modular architecture implementation

_Formerly the file `modular-architecture-codex-audit.md`, merged 2026-11-03._

> **Status as of 2026-11-02:** a snapshot as of the 0.1.5 audit. The table of stages MOD-00…MOD-10 reflects the state at that time; the package manager has since been implemented in Rust (`package_manager.rs`). Not re-verified.

Review date: 2026-09-21.

The current working tree was reviewed after the claim that `MOD-00—MOD-10` from `modular-architecture-0.1.5-plan.md` were fully completed.

### Summary

The claim "all stages are fully completed" is not confirmed.

A useful prototype has appeared in the project:

- the `enabledModules` configuration at the space level;
- a basic `ModuleHost` and contribution registries;
- disabling part of the UI and the database runtime;
- decoupling of the shared Excalidraw and Canvas components;
- `React.lazy` for the Canvas and Excalidraw editors and the database interface;
- a profiles interface in settings;
- a set of unit tests for the new pure functions.

This is a basis for further work, but it is not yet a system of installable and removable modules. Packages are not downloaded and not published to disk, the module code remains in the app, there is no cryptographic verification, community plugins are not executed in a sandbox, and the mandatory acceptance is only partly covered.

The current implementation should be considered a `MOD-01/MOD-02` prototype with partial code splitting. It must not be released as a complete modular architecture.

### Stage status

| Stage  | Status          | Actual result                                                                                                                                                                 |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOD-00 | Partial         | There is an inventory of frontend chunks and dependencies. The required measurements of cold start, memory, installer and Rust binary contribution are missing.               |
| MOD-01 | Partial         | `enabledModules` is written to `.amby/workspace.json`, but global installation remains fictitious, and the state is still served through the old presets and `activeModules`. |
| MOD-02 | Prototype       | `ModuleHost`, the registries and the capability API exist, but they do not form a mandatory boundary for built-in features and do not fully control the workspace.            |
| MOD-03 | Not completed   | Profiles are shown in the settings of an existing space. There is no choice at first space creation, no real download, no catalog and no verified signature.                  |
| MOD-04 | Not implemented | There is an in-memory installer model. There is no real download, staging directory, unpacking, atomic publication of files, cryptographic signature or durable rollback.     |
| MOD-05 | Partial         | Excalidraw is decoupled from Canvas and wrapped in `React.lazy`, but it remains in the distribution and is in fact preloaded by the start page.                               |
| MOD-06 | Partial         | Canvas got the same UI disabling and a lazy component, but did not become an installable or removable package.                                                                |
| MOD-07 | Partial         | Snapshot creation is conditionally blocked by `enabledModules`, but the whole history backend remains in the core; the provider boundary has not been created.                |
| MOD-08 | Partial         | The database UI loads lazily and the runtime can switch itself off. The other "modules" are still statically bundled and directly tied to the workspace.                      |
| MOD-09 | Not implemented | A class of the RPC dispatcher is named sandbox, but there is no separate execution environment and no loading of third-party code.                                            |
| MOD-10 | Not completed   | The unit tests pass, but the mandatory scenarios are not fully covered, and `npm run verify` fails.                                                                           |

### Critical discrepancies

#### 1. The package manager does not install packages

`stagePackage` accepts a ready-made `Record<string, string>` object and returns it in memory as `stagedFiles`. No temporary directory is created, no archive is unpacked and the package files are not written.

`publishStagedPackage` changes only `modules.json`. The fields `entry`, `style` and `stagedFiles` are not published to `modules/<id>/<version>/`, and the runtime does not load the entry point of the installed package.

`uninstallModule` removes only the registry entry. On the next read, `loadGlobalModulesRegistry` adds every built-in module back from `BUILTIN_MODULES`, so such a removal of a built-in module is not preserved.

The version history for rollback lives in the process variable `moduleVersionHistory`. After the app restarts, the history disappears. The old package files do not exist at all, so switching `activeVersion` cannot restore working code.

Conclusion: `MOD-04` is so far an API model and a unit-test mock-up.

#### 2. The signature check is not Ed25519

`validateSignature` accepts any string starting with `ed25519:` if the textual `keyId` matches. The manifest contents and checksums are not verified cryptographically.

Profile signatures are checked the same way. The signature and checksum strings of the official catalog are placeholder values.

This must not be described in release notes as Ed25519 verification or a signed catalog. Until real verification is implemented, such a claim creates a false sense of security.

#### 3. There is no physical separation of Excalidraw and Canvas

`React.lazy` creates separate chunks but does not remove them from the app. After an independent build, `dist` contains:

- `vendor-excalidraw`: about 4.05 MB of JavaScript;
- Excalidraw CSS: about 200 KB;
- `vendor-xyflow`: about 173 KB of JavaScript;
- xyflow CSS: about 16 KB;
- the Canvas and Excalidraw editor chunks.

Moreover, `dist/index.html` contains `modulepreload` for `vendor-excalidraw` and `vendor-xyflow` and also links their CSS. The main entry imports both vendor chunks. So the claim "never loaded in the Minimum profile" is in fact false for the current production build.

The size of `dist` after the changes remains about 12 MB. Code splitting reduced the main `index` chunk and is a useful optimization, but it is not a reduction of the installation package and not a physically removable module.

#### 4. The Module Host is so far bypassed by static code

All official module definitions are imported statically in `host/builtins.ts` and registered automatically when the file is imported. The registry of installed modules does not determine which code is available to the runtime.

`panel-definitions.tsx` keeps statically importing the Tags, Favorites, Databases, History, Links and AI panels. After checking the dynamic registry, `findPanelDef` falls back to the static `PANEL_DEFS`, so the host is not the only source of contributions.

`FileHandlerRegistry` registers `.canvas`, `.excalidraw`, `.sketch` and `.ambd`, but production code does not request handlers from it when opening files. The special branches for Canvas, Excalidraw, Database and Graph remain in `workspace-orchestration.tsx` and `document-body.tsx`.

The capability broker controls only voluntary calls made through the created `ExtensionApi`. The built-in panels and editors keep importing `@/lib/storage` directly, so their real operations are not restricted by manifest permissions.

#### 5. Switching spaces keeps the old ModuleHostContext

`ModuleHost.syncWithWorkspace` compares only the set of module IDs. If a module is enabled in both space A and space B, it is neither deactivated nor activated again. The `ExtensionApi` created on first activation keeps containing the path of space A.

The calls of `moduleHost.syncWithWorkspace` from `use-presets.ts` are launched via `void` and are not awaited. A quick switch of space or preset can start overlapping activate/deactivate operations.

The acceptance test checks only the transition from "enabled in A" to "disabled in B". The scenario "enabled in both spaces, but the context must change" is missing.

This is a blocking bug for the requirement of global installation and independent per-space enabling.

#### 6. Safe mode and quarantine are not connected to app startup

Safe mode and quarantine are stored only in memory. There is no state persistence, no startup recovery, no management screen and no way to start the app without community plugins.

`ModuleHost` creates its own instances of `QuarantineManager` and `SafeModeState`. `CommunityPluginSandbox` checks a different global instance, `quarantineManager`. So errors recorded by the host are not necessarily visible to the community plugin's check.

Repeated errors are counted only during `activate`. Failures of a panel, command, background task or RPC after a successful activation do not automatically end up in quarantine.

#### 7. CommunityPluginSandbox is not a sandbox

The `CommunityPluginSandbox` class runs in the same JavaScript context as the application. It does not create a `Worker`, a sandboxed iframe, or a separate WebView, does not load plugin code, and does not restrict global objects.

The class implements an RPC switch for tests and itself calls the global `fetch` and `navigator.clipboard`. Third-party code is not connected to it. If a third-party entry point is imported with a plain `import()`, that code gets the same `window` and Tauri globals, bypassing this RPC class.

Thus `MOD-09` has not been started at the execution-isolation level. Only a prototype of the intended RPC API is implemented.

#### 8. Profiles are not first-run profiles

`ProfileSelector` is used only inside the modules tab in Settings. `WorkspacePicker` and the add-space flow contain no profile choice.

Clicking «Кастомный» (Custom) in the current profile handler does nothing: only `minimal` and `standard` are handled. There is no transactional installation of the selected set.

The online/offline fields and sizes are static data. The code does not check the network, does not download a catalog, and does not install missing packages.

#### 9. Migration proceeds without the mandatory backup

`backupWorkspaceConfig` catches the write error and returns an empty string, after which the migration is still considered complete and the new configuration may be saved over the old one.

This contradicts the accepted migration contract: a backup/recovery point must be published before persistent data is changed. There is also no separate migration version, no result journal, and no rollback operation.

#### 10. History is only switched off by a condition, not separated

The entire Rust backend, IPC, and history UI remain inside the application. Before creating a snapshot, Rust reads `.amby/workspace.json` and checks `enabledModules`.

If the file is missing, a read error occurs, a JSON error occurs, or the field is missing, the function returns `true`, that is, history is enabled. There is no test for disabled history in the Rust suite.

This may be an intermediate step, but it is not a completion of `MOD-07`. A separate history provider and an explicitly tested lifecycle are needed; recovery drafts must remain independent.

#### 11. The acceptance suite does not cover the declared scenarios

The file is called a suite of scenarios `1-17`, but contains checks only for:

- 1;
- 2;
- 3;
- 4;
- 10;
- 11;
- 13 and 14 in a single unit test;
- 16.

There are no checks for dirty-document disable, preserving `.canvas` on uninstall, reinstallation, Excalidraw working offline, disabled history and recovery, permission expansion on update, preserving packages after an app update, an unknown file type, and the absence of split-off chunks in the minimal distribution.

The rollback test only checks that the function returned an object. It does not install two versions, does not require a successful rollback, and does not verify code restoration.

### Results of independent commands

| Command                      | Result                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| `npm run build`              | PASS; production bundle created                                 |
| `npm run test` within verify | 114 files, 713 tests PASS                                       |
| `npm run rust:test`          | 335 PASS, 2 ignored                                             |
| `npm run rust:fmt`           | PASS                                                            |
| `npm run rust:clippy`        | PASS                                                            |
| `npm run verify`             | FAIL at `format:check`                                          |
| `npm run knip` separately    | FAIL: 1 unused file, 15 unused exports, 5 unused exported types |

`format:check` flagged the following files:

- `docs/road/modular-architecture-inventory.md`;
- `src/components/workspace/app-config.ts`;
- `src/components/workspace/canvas/canvas-note-picker-modal.tsx`;
- `src/components/workspace/settings-dialog.tsx`;
- `src/lib/modules/modular-acceptance.test.ts`.

Therefore the claim of fully passed final verification is incorrect. `verify:fast` does not replace the mandatory `npm run verify`, because it does not run Prettier, Knip, Rustfmt, Clippy, Rust tests, or the bindings check.

### What can be kept

The following changes have practical value and can become the first increment after the discovered errors are fixed:

1. The neutral `ToolbarButton`, `NotePickerModal`, and card functions that remove Excalidraw's direct dependency on Canvas.
2. `enabledModules` in the space configuration after a safe migration.
3. The UI fallback for disabled Canvas, Excalidraw, Database, and Graph.
4. Disabling the databases runtime through the existing backend state.
5. The shared shape of `ModuleHost`, contributions, and lifecycle after fixing the space switch and making registry use mandatory.
6. Lazy boundaries as a separate startup-code optimization after eliminating the actual preload of heavy vendor chunks.
7. Unit tests of pure functions as a start, but not as proof of full acceptance.

### Recommended order of fixes

#### Block 1. Bring the report and release notes in line with the facts

- remove claims of full completion of `MOD-00—MOD-10`;
- replace "physical separation" with "first stage of code splitting";
- remove claims about Ed25519, sandbox, atomic installation, and removable packages until they are implemented;
- note the incomplete verify.

#### Block 2. Stabilize the intermediate built-in lifecycle

- fix the vault context change when the set of modules is the same;
- serialize host operations and await `syncWithWorkspace`;
- make the host the single source of module panels, commands, and file handlers;
- connect the file handler registry to document opening;
- reconcile a single safe mode/quarantine instance;
- add integration tests for space switching, dirty disable, and resource cleanup.

#### Block 3. Complete MOD-01 and MOD-03

- separate the profile from the layout and the old preset lifecycle;
- add profile selection to the space creation flow;
- implement Custom as a real choice;
- do not consider a module enabled if it is not installed;
- abort the migration when the backup fails;
- add a version, an outcome journal, and migration rollback.

#### Block 4. Implement a real MOD-04

- move package installation to the Rust backend;
- download into a staging directory;
- verify the archive before and after unpacking;
- use a real Ed25519 verification of the canonical manifest bytes and checksums;
- atomically publish `modules/<id>/<version>/`;
- keep several versions and a durable rollback history;
- load the entry point only from the active installed version;
- delete the package code while preserving user data.

#### Block 5. Physically separate the first official module

- choose Excalidraw as the pilot;
- remove the dependency from the base `package.json`/bundle, or build a separate signed package;
- exclude vendor JS/CSS from the `dist` of the "Minimum" profile;
- check the Tauri bundle size before and after;
- test installation, launch, disabling, removal, and reinstallation on real files.

Only after this can Canvas, History, and Databases be moved and `MOD-09` started with a real separate execution environment.

### Criteria for the next acceptance

The next completion request must contain:

1. A link to the real directory of an installed package and its files.
2. A test with a forged `ed25519:anything` string that is necessarily rejected by cryptographic verification.
3. A "Minimum" build in which Excalidraw and Canvas JS/CSS are absent.
4. An application restart with a preserved rollback and quarantine.
5. A switch A → B with a module equally enabled, with confirmation of the new vault context.
6. A full sandbox escape test in a separate runtime.
7. All 18 scenarios of the original plan, including checks of the filesystem and desktop behavior.
8. Successful `npm run verify` and `npm run build`.

Until these conditions are met, the current result should be accepted as an architectural prototype, not a completed modular system.
