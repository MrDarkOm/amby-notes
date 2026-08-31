import { describe, it } from "vitest"
import { storageContractCases, type StorageContractContext } from "./storage-contract"

export function runStorageContract(
  name: string,
  create: () => Promise<StorageContractContext> | StorageContractContext,
): void {
  describe(`${name} storage contract`, () => {
    for (const scenario of storageContractCases) {
      it(scenario.name, async () => {
        const context = await create()
        try {
          await scenario.run(context)
        } finally {
          await context.cleanup?.()
        }
      })
    }
  })
}
