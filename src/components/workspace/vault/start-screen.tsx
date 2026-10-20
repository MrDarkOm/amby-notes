"use client"

import { EmptyStateHeader } from "./empty-state-header"
import { VaultManager, type VaultManagerProps } from "./vault-manager"

/** Shown when no vault is open: the vault manager under the draggable window header. */
export function StartScreen(props: Omit<VaultManagerProps, "currentPath">) {
  return (
    <div className="flex h-screen flex-col bg-background">
      <EmptyStateHeader />
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="w-full max-w-sm">
          <VaultManager {...props} />
        </div>
      </div>
    </div>
  )
}
