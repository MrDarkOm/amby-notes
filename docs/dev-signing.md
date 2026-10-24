# macOS signing and the Keychain prompt

Sync keeps the account key and the device token in the system key store as one entry
(`com.ambynotes.sync` / `credentials`). macOS asks for the login password the first time a build reads
an entry and offers "Always Allow". That answer is remembered **for the signature of the program**, so
what the signature is decides how often the prompt comes back.

## Development (`tauri dev`, debug builds)

A debug binary is signed ad hoc by the linker, and an ad-hoc signature is the hash of the code
(`cdhash`). Every rebuild changes it, so the Keychain treats each build as a new program and asks again.
Signing the binary with one fixed local certificate makes the identity
`identifier "com.ambynotes.app.dev" and certificate leaf = <hash of your certificate>`, which does not
change between builds.

This is opt-in. [.cargo/config.toml](../.cargo/config.toml) makes cargo run
[scripts/dev-sign-run.sh](../scripts/dev-sign-run.sh) before every start of the `amby-notes` binary
(`tauri dev` included). The script signs the binary only when a certificate named `Amby Dev Signing`
exists, and otherwise just starts the program. It never creates a certificate and never touches the
keychain. `npm run dev:sign-check` says whether the certificate is found. `AMBY_DEV_SIGN=0` turns signing
off; `AMBY_DEV_SIGN_IDENTITY` and `AMBY_DEV_SIGN_KEYCHAIN` choose another name or keychain file.

### One-time setup (the owner runs this, once)

The certificate is a self-signed one for code signing, kept in the login keychain. In Terminal:

```bash
cd "$(mktemp -d)" && openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -subj "/CN=Amby Dev Signing" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" && openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -out amby.p12 -passout pass:amby && security import amby.p12 -k ~/Library/Keychains/login.keychain-db -P amby -T /usr/bin/codesign && cd - >/dev/null
```

Then check it:

```bash
npm run dev:sign-check
```

Instead of the command, the same certificate can be made in Keychain Access → Certificate Assistant →
Create a Certificate: name `Amby Dev Signing`, Identity Type "Self Signed Root", Certificate Type "Code
Signing".

The first `tauri dev` afterwards may ask once for the login password so that `codesign` may use the
key ("Always Allow"). Delete the temporary folder when done; the certificate stays in the keychain.

### What to expect

- Once, after setup: one prompt for the entry in the new key store form, answered with "Always Allow".
  The program now has a new identity, so the entries made by earlier unsigned builds ask once more.
- Rebuilds after that: no prompt. The certificate lasts 10 years; to undo, delete it in Keychain Access.

## Release builds

Release signing is not changed by this note. Today (`src-tauri/tauri.macos.conf.json`) the macOS bundle
is signed **ad hoc** (`signingIdentity: "-"`) and not notarized (no Apple certificates in
`.github/workflows/release.yml`). An ad-hoc signature again means "the hash of this exact build", so
"Always Allow" holds only within one installed version: after every update (or reinstall) the prompt
comes back once. With one entry that is one prompt per update.

What would make it "once, ever" is signing every release with the same identity, ideally a Developer ID
certificate (the identity is then the Team ID plus the bundle identifier `amby-notes`, the same for all
versions). That is a release-process decision (Apple Developer account, secrets in GitHub Actions,
notarization) and is left to the owner.
