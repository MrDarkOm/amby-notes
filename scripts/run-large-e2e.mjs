import { spawnSync } from "node:child_process"
import process from "node:process"

const requested = process.env.AMBY_E2E_LARGE_VAULT_SIZE ?? "1000"
if (!new Set(["1000", "5000", "10000"]).has(requested)) {
  throw new Error("AMBY_E2E_LARGE_VAULT_SIZE must be 1000, 5000, or 10000")
}

const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "desktop_e2e_large_vault_smoke_reports_scan_reopen_update_and_search",
    "--",
    "--ignored",
    "--nocapture",
  ],
  {
    env: { ...process.env, AMBY_E2E_LARGE_VAULT_SIZE: requested },
    stdio: "inherit",
  },
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
