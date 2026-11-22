import { getVersion } from "@tauri-apps/api/app"
import { Channel, invoke } from "@tauri-apps/api/core"
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
  {
    name: "native updater reaches download and install resource validation",
    async run() {
      const rid = 0xffffffff
      const steps = [
        { command: "download", args: { rid, onEvent: new Channel() } },
        { command: "install", args: { updateRid: rid, bytesRid: rid } },
      ]
      for (const { command, args } of steps) {
        let rejection = ""
        try {
          await invoke(`plugin:updater|${command}`, args)
        } catch (error) {
          rejection = String(error)
        }
        if (!rejection.includes(`The resource id ${rid} is invalid.`))
          throw new Error(
            `Native updater ${command} did not reach resource validation: ${rejection}`,
          )
      }
    },
  },
]
