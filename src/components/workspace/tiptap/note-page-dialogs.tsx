import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"

export function NotePagePicker({
  titles,
  onSelect,
  onClose,
}: {
  titles: string[]
  onSelect: (index: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t("docEditor.notePages.jump")}
      description={t("docEditor.notePages.jumpHint")}
      showCloseButton={false}
    >
      <CommandInput placeholder={t("docEditor.notePages.jumpHint")} />
      <CommandList>
        <CommandEmpty>{t("editor.find.none")}</CommandEmpty>
        {titles.map((title, index) => (
          <CommandItem
            key={index}
            value={`page-${index}`}
            keywords={[title]}
            onSelect={() => onSelect(index)}
          >
            {title}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

export function ExtractNotePageDialog({
  onCreate,
  onClose,
}: {
  onCreate: (title: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogTitle>{t("docEditor.notePages.extract")}</DialogTitle>
        <DialogDescription>{t("docEditor.notePages.extractHint")}</DialogDescription>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) onCreate(name)
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={t("docEditor.notePages.nameField")}
            placeholder={t("docEditor.notePages.nameField")}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
          />
          <Button type="submit" disabled={!name.trim()}>
            {t("docEditor.notePages.extractConfirm")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
