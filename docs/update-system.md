# Application update system

Amby uses the Tauri updater with a static `latest.json` file attached to the
latest public GitHub Release. Update archives are verified with the public key
embedded in `src-tauri/tauri.conf.json`; unsigned or incorrectly signed
artifacts are rejected before installation.

## One-time GitHub setup

The matching private key is generated locally at
`.tauri/amby-updater.key` and is intentionally ignored by Git. Back it up in a
secure password manager before publishing the first update. Losing it prevents
existing installations from accepting future updates.

Add the complete private-key contents to the repository Actions secret
`TAURI_SIGNING_PRIVATE_KEY`. The generated key currently has no password, so
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` may be omitted or left empty. If the key is
replaced with a password-protected key, add its password as that second secret.

Platform code signing and notarization are separate from updater signatures.
Production releases must still satisfy the macOS and Windows signing gates in
`docs/release-readiness.md`.

## Publishing a release

1. Follow the cumulative release workflow in `AGENTS.md`: finalize the public
   notes in `updates.md` and increment the patch version exactly once.
2. Run `npm run version:check`, `npm run verify`, and `npm run build`.
3. Commit and push the release candidate when explicitly requested.
4. After explicit authorization to publish a release, create tag `v<version>`
   and push it.
5. The `Release` workflow builds macOS arm64/x64, Linux x64, and Windows x64,
   signs the updater artifacts in one draft, and publishes it with `latest.json`
   only after every platform succeeds.
6. Verify the release assets and run an installed-version update smoke test
   before promoting the release through the documented channels.

The workflow rejects a tag whose version does not match any of the three
version sources. Draft and prerelease GitHub releases are not used by the
`/releases/latest/` updater endpoint.
