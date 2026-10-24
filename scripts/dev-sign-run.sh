#!/bin/sh
# Cargo runner for macOS (.cargo/config.toml): signs the freshly built debug binary with a fixed
# local identity, then runs it. A rebuilt unsigned binary has a new identity every time, so the
# Keychain forgets "Always Allow" and asks for the password again; a binary signed with the same
# certificate is the same app to the Keychain after every rebuild.
#
# Opt-in: with no such certificate this script only runs the program. It never creates a
# certificate and never changes the keychain. Setup: docs/dev-signing.md.
#   AMBY_DEV_SIGN_IDENTITY  certificate name (default "Amby Dev Signing")
#   AMBY_DEV_SIGN_KEYCHAIN  keychain file to look in (default: the user's keychains)
#   AMBY_DEV_SIGN=0         turn signing off
#
# The identifier is fixed on purpose: together with the certificate it is the app's identity.

identity="${AMBY_DEV_SIGN_IDENTITY:-Amby Dev Signing}"
identifier="com.ambynotes.app.dev"
binary="$1"

has_identity() {
  security find-identity -p codesigning ${AMBY_DEV_SIGN_KEYCHAIN:+"$AMBY_DEV_SIGN_KEYCHAIN"} 2>/dev/null |
    grep -q "\"$identity\""
}

# `npm run dev:sign-check`: says whether signing will happen.
if [ "$1" = "--check" ]; then
  if has_identity; then
    echo "Found \"$identity\": debug builds of tauri dev will be signed."
  else
    echo "No \"$identity\" certificate: debug builds stay unsigned (see docs/dev-signing.md)."
  fi
  exit 0
fi

sign_if_possible() {
  [ "${AMBY_DEV_SIGN:-1}" = "0" ] && return 0
  [ "$(uname -s)" = "Darwin" ] || return 0
  [ -f "$binary" ] || return 0
  # Only the application itself; test and build-script binaries do not use the key store.
  case "$(basename "$binary")" in amby-notes) ;; *) return 0 ;; esac
  command -v security >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1 || return 0
  # Without -v: a self-made certificate is listed here even when the system does not "trust" it.
  has_identity || return 0
  # Already signed by this certificate with this identifier: nothing to do.
  current="$(codesign -dvv "$binary" 2>&1)"
  if printf '%s' "$current" | grep -q "^Authority=$identity\$" &&
    printf '%s' "$current" | grep -q "^Identifier=$identifier\$"; then
    return 0
  fi
  if ! codesign --force --sign "$identity" --identifier "$identifier" \
    ${AMBY_DEV_SIGN_KEYCHAIN:+--keychain "$AMBY_DEV_SIGN_KEYCHAIN"} "$binary" >/dev/null 2>&1; then
    echo "dev-sign-run: could not sign with \"$identity\"; running unsigned" >&2
  fi
}

sign_if_possible
exec "$@"
