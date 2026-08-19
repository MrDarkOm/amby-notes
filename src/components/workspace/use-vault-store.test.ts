import { beforeEach, describe, expect, it } from "vitest"
import { useVaultStore } from "./use-vault-store"

describe("vault store generation", () => {
  beforeEach(() => {
    useVaultStore.setState({ vault: null, generation: 1, backendGeneration: null, vaults: [] })
  })

  it("advances only after a successful vault identity change", () => {
    const { setVault } = useVaultStore.getState()

    setVault("/vault/one")
    expect(useVaultStore.getState()).toMatchObject({ vault: "/vault/one", generation: 2 })

    setVault("/vault/one")
    expect(useVaultStore.getState().generation).toBe(2)

    setVault("/vault/two")
    expect(useVaultStore.getState()).toMatchObject({ vault: "/vault/two", generation: 3 })
  })
})
