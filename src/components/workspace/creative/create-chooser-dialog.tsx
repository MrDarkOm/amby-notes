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
  const option = ({ value, icon: Icon, title, hint }: ChooserOption) => (
    <button
      key={value}
      type="button"
      onClick={() => onPick(value)}
      className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/40 hover:bg-accent/30"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* What is picked often goes on in the lists, in a field that must keep focus. */}
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-md border-border bg-background text-foreground"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("creative.chooser.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">{common.map(option)}</div>
        {rare.length > 0 && (
          <>
            {common.length > 0 && (
              <p className="text-xs font-medium text-muted-foreground">
                {t("creative.chooser.rare")}
              </p>
            )}
            <div className="grid gap-2">{rare.map(option)}</div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
