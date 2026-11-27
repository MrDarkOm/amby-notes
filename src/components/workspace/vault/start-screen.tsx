"use client"

import { Loader2 } from "lucide-react"
import { MotionSpinner } from "@/lib/motion"
import { useTranslation } from "react-i18next"
import { EmptyStateHeader } from "./empty-state-header"
import { VaultManager, type VaultManagerProps } from "./vault-manager"

/**
 * Shown when no vault is open: the vault manager under the draggable window header.
 * While startup is still reopening the last vault it shows a loader instead, so the
 * list of vaults does not flash by and the wait does not look like a lost vault.
 */
export function StartScreen({
  loading = false,
  ...props
}: Omit<VaultManagerProps, "currentPath"> & { loading?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-screen flex-col bg-background">
      <EmptyStateHeader />
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        {loading ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <MotionSpinner>
              <Loader2 className="size-4" aria-hidden />
            </MotionSpinner>
            {t("vaultPicker.loading")}
          </div>
        ) : (
          <div className="w-full max-w-sm">
            <VaultManager {...props} />
          </div>
        )}
      </div>
    </div>
  )
}
