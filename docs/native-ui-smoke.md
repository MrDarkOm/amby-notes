# Native UI smoke harness

Run `npm run test:native:ui` to open the production React interface in a real
Tauri/WebView runtime with disposable vaults, isolated global settings and an
isolated WebView profile. The opt-in `native-contract` feature is never enabled
by normal development or production builds. The runner refuses to reuse a path
without its exact marker. It does not read existing Amby settings or vaults.

The command prints the generated profile path. Reopen the same profile with
`npm run test:native:ui -- "<printed path>"` to test full process restart.
Generated profiles live under ignored `.release-evidence/` and remain available
for byte-level verification. The regular storage contract still deletes its
own temporary profile automatically.

Windows smoke on 2026-09-01 covered UI save/autosave, close/reopen, rename,
successful and failed dirty vault switching, external create/edit/rename/delete,
external conflict resolution with local-copy preservation, deleted-file restore,
controlled identity migration, duplicate identity visibility, and a supported
paragraph edit in the compatibility corpus. The latter changed exactly the
intended paragraph while keeping every other fixture byte-exact and preserving
the rest of the edited file byte-for-byte.

This harness is full React lifecycle evidence, but it does not claim installer,
code-signing, removable/network-filesystem, or multi-window acceptance.
