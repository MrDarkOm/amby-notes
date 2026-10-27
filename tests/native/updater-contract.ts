import { getVersion } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { commands } from "../../src/lib/bindings"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"

export const nativeUpdaterCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "native updater release identity and denied generic downgrade check",
    async run() {
      const release = await commands.appReleaseVersion()
      const base = await getVersion()
      if (
        release.status !== "ok" ||
        !new RegExp(`^${base.replace(/\./g, "\\.")}(?:-beta\\.[1-9]\\d*)?$`).test(release.data)
      )
        throw new Error("Native release identity must match the numeric application version")
      let rejection = ""
      try {
        await invoke("plugin:updater|check", { allowDowngrades: true })
      } catch (error) {
        rejection = String(error)
      }
      if (!/not allowed|not permitted|denied/i.test(rejection))
        throw new Error(`Generic updater check was not denied by capabilities: ${rejection}`)
    },
  },
]
