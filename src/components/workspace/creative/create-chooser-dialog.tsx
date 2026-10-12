import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { ChooserOption, CreateChoice } from "./chooser-options"

interface CreateChooserDialogProps {
  open: boolean
  onClose: () => void
  options: ChooserOption[]
  onPick: (choice: CreateChoice) => void
}

export function CreateChooserDialog({ open, onClose, options, onPick }: CreateChooserDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md border-border bg-background text-foreground">
        <DialogHeader>
          <DialogTitle>{t("creative.chooser.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          {options.map(({ value, icon: Icon, title, hint }) => (
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
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
