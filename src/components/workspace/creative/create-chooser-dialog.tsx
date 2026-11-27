import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { groupChooserOptions, type ChooserOption, type CreateChoice } from "./chooser-options"

interface CreateChooserDialogProps {
  open: boolean
  onClose: () => void
  options: ChooserOption[]
  onPick: (choice: CreateChoice) => void
}

export function CreateChooserDialog({ open, onClose, options, onPick }: CreateChooserDialogProps) {
  const { t } = useTranslation()
  const tile = ({ value, icon: Icon, title, hint }: ChooserOption) => (
    <button
      key={value}
      type="button"
      aria-label={title}
      title={hint}
      onClick={() => onPick(value)}
      className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-2 text-left text-xs font-medium hover:border-primary/40 hover:bg-accent/50"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-words">{title}</span>
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
        <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
          {groupChooserOptions(options).map(({ group, options }) => {
            const label = t(`creative.chooser.groups.${group}`)
            return (
              <section key={group} aria-label={label} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
                <div className="grid grid-cols-2 gap-1.5">{options.map(tile)}</div>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
