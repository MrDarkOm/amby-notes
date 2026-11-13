import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"

/**
 * "Оформить подписку" (docs/sync-plan.md, appendix Н, Н11): payment does not exist yet, so the button
 * only opens one calm line under itself. No window, no navigation, no request; no price, because the
 * owner of the server sets it.
 */
export function SubscriptionOffer({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {t("sync.account.buySubscription")}
      </Button>
      {open && (
        <p data-testid="subscription-stub" className="text-[12px] text-muted-foreground">
          {t("sync.account.buyStub")}
        </p>
      )}
    </div>
  )
}
