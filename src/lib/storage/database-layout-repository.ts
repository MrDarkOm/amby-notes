import { commands, type LayoutStatus } from "../bindings"

export function createDatabaseLayoutPort(native: boolean) {
  const call = async (upgrade: boolean, generation: number): Promise<LayoutStatus> => {
    if (!native) return { pendingDatabases: 0 }
    const result = await (upgrade
      ? commands.upgradeDatabaseLayout(generation)
      : commands.databaseLayoutStatus(generation))
    if (result.status === "error") throw new Error("databaseLayoutFailed")
    return result.data
  }
  return {
    scan: (generation: number) => call(false, generation),
    upgrade: (generation: number) => call(true, generation),
  }
}
