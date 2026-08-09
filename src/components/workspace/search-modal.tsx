"use client"

import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { SidebarSearch } from "./sidebar-search"
import type { TreeItem } from "./sidebar-tree"

interface SearchModalProps {
  open: boolean
  onClose: () => void
  items: TreeItem[]
  onSelect: (id: string) => void
  readFile?: (path: string) => Promise<string>
}

export function SearchModal({ open, onClose, items, onSelect, readFile }: SearchModalProps) {
  const { t } = useTranslation()
  function handleSelect(id: string) {
    onSelect(id)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[14%] left-1/2 w-[560px] max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-0 gap-0 overflow-hidden border-border bg-background p-0 shadow-2xl"
      >
        <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
        <div className="h-[460px]">
          <SidebarSearch items={items} onSelect={handleSelect} readFile={readFile} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
