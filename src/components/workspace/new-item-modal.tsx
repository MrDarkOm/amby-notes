"use client"

import * as React from "react"
import { Database, FileText, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface NewItemModalProps {
  open: boolean
  onClose: () => void
  onCreateNote: () => void
}

export function NewItemModal({ open, onClose, onCreateNote }: NewItemModalProps) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-80 border-zinc-800 bg-zinc-950 p-0 text-zinc-100 shadow-2xl">
        <DialogHeader className="border-b border-zinc-800 px-4 py-3">
          <DialogTitle className="text-sm font-medium text-zinc-300">Создать новый элемент</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 p-4">
          {/* Note */}
          <button
            onClick={() => { onClose(); onCreateNote() }}
            className="flex flex-col items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-5 text-center transition-colors hover:border-zinc-600 hover:bg-zinc-800"
          >
            <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-800">
              <FileText className="size-5 text-zinc-300" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-200">Заметка</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">Markdown файл</p>
            </div>
          </button>

          {/* Database — placeholder */}
          <div className="flex flex-col items-center gap-2.5 rounded-lg border border-zinc-800/50 bg-zinc-900/40 px-4 py-5 text-center opacity-50 cursor-not-allowed select-none">
            <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-800/60">
              <Database className="size-5 text-zinc-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-400">База данных</p>
              <p className="mt-0.5 text-[11px] text-zinc-600">Скоро</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
