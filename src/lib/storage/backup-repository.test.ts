import { beforeEach, expect, it, vi } from "vitest"
const commands = vi.hoisted(() => ({
  listVaultBackups: vi.fn(),
  verifyVaultBackup: vi.fn(),
  restoreVaultBackup: vi.fn(),
}))
vi.mock("../bindings", () => ({ commands }))
import { createBackupPort } from "./backup-repository"
beforeEach(() => vi.clearAllMocks())
it("refuses filesystem operations in the browser", async () => {
  const port = createBackupPort(false)
  await expect(port.list("/vault")).rejects.toMatchObject({ code: "unavailable" })
  expect(commands.listVaultBackups).not.toHaveBeenCalled()
})
it("uses active vault scope and a replayable restore intent", async () => {
  commands.listVaultBackups.mockResolvedValue({ status: "ok", data: { generation: 5 } })
  commands.restoreVaultBackup.mockResolvedValue({ status: "ok", data: null })
  const port = createBackupPort(true)
  await port.list("/vault")
  await port.restore(5, "backup-id", "operation-id")
  expect(commands.listVaultBackups).toHaveBeenCalledWith("/vault")
  expect(commands.restoreVaultBackup).toHaveBeenCalledWith(5, "backup-id", "operation-id")
})
it("returns only a machine code for failed IPC", async () => {
  commands.verifyVaultBackup.mockRejectedValue(new Error("private credential detail"))
  await expect(createBackupPort(true).verify(5, "id")).rejects.toMatchObject({
    message: "backup_failed",
    code: "backup_failed",
  })
})
