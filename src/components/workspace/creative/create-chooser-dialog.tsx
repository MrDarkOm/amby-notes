import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { splitChooserOptions, type ChooserOption, type CreateChoice } from "./chooser-options"

interface CreateChooserDialogProps {
  open: boolean
  onClose: () => void
  options: ChooserOption[]
  onPick: (choice: CreateChoice) => void
}

export function CreateChooserDialog({ open, onClose, options, onPick }: CreateChooserDialogProps) {
  const { t } = useTranslation()
  const { common, rare } = splitChooserOptions(options)
  const commonTile = ({ value, icon: Icon, title, hint }: ChooserOption) => (
    <button
      key={value}
      type="button"
      title={hint}
      onClick={() => onPick(value)}
      className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-2 text-left text-xs font-medium hover:border-primary/40 hover:bg-accent/50"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{title}</span>
      <span className="sr-only"> {hint}</span>
    </button>
  )
  const rareItem = ({ value, icon: Icon, title, hint }: ChooserOption) => (
    <button
      key={value}
      type="button"
      title={hint}
      onClick={() => onPick(value)}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{title}</span>
      <span className="sr-only"> {hint}</span>
    </button>
  )
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* What is picked often goes on in the lists, in a field that must keep focus. */}
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-xs gap-2.5 border-border bg-background p-3.5 text-foreground"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{t("creative.chooser.title")}</DialogTitle>
        </DialogHeader>
        {common.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5" data-testid="chooser-common-grid">
            {common.map(commonTile)}
          </div>
        )}
        {rare.length > 0 && (
          <>
            {common.length > 0 && (
              <p className="border-t border-border pt-2 text-[11px] font-medium text-muted-foreground">
                {t("creative.chooser.rare")}
              </p>
            )}
            <div className="flex flex-col gap-0.5" data-testid="chooser-rare-list">
              {rare.map(rareItem)}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
