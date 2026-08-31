import { DesktopAdapter } from "../../src/lib/storage/desktop-adapter"
import { joinStoragePath } from "../../src/lib/storage/storage-path"
import { storageContractCases } from "../../src/lib/storage/storage-contract"
import { nativeNoteCases } from "./note-contract"

const root = (window as unknown as { __AMBY_NATIVE_TEST_ROOT__: string }).__AMBY_NATIVE_TEST_ROOT__
if (!root || !("__TAURI_INTERNALS__" in window))
  throw new Error("A real native test runtime is required")
const adapter = new DesktopAdapter()
const results: Array<{ name: string; passed: boolean; error?: string }> = []
try {
  for (const [index, scenario] of [...storageContractCases, ...nativeNoteCases].entries()) {
    await adapter.loadVaultData(root)
    const vaultPath = await adapter.createFolder(root, `case-${index}`)
    await adapter.loadVaultData(vaultPath)
    try {
      await scenario.run({ adapter, vaultPath })
      results.push({ name: scenario.name, passed: true })
    } catch (error) {
      results.push({ name: scenario.name, passed: false, error: String(error) })
    }
  }
} catch (error) {
  results.push({ name: "harness", passed: false, error: String(error) })
}
const report = JSON.stringify({ passed: results.every((result) => result.passed), results })
document.getElementById("result")!.textContent = report
await adapter.loadVaultData(root)
await adapter.writeFile(joinStoragePath(root, "result.json"), report)
