import * as React from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useConfirmStore, type PendingConfirm } from "@/lib/confirm"

function ConfirmDialog({ question }: { question: PendingConfirm }) {
  const { t } = useTranslation()
  const settle = useConfirmStore((state) => state.settle)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const destructive = Boolean(question.destructive)
  // An irreversible action that asks for the exact name first (Л10): nothing is confirmed until it matches.
  const [typed, setTyped] = React.useState("")
  const required = question.requiredText
  const allowed = !required || typed === required.value
  // What had the focus when the question came; it gets it back (Radix returns it only to a trigger, and there is none).
  const [opener] = React.useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )

  return (
    <Dialog open onOpenChange={(open) => !open && settle(question.id, "dismissed")}>
      <DialogContent
        role="alertdialog"
        data-destructive={destructive ? "true" : "false"}
        showCloseButton={false}
        // The focus starts on the safe button when the action is dangerous, so a stray Enter cancels.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(destructive ? cancelRef : confirmRef).current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener?.isConnected) opener.focus()
        }}
        className="w-96 border-border bg-popover p-5 text-foreground"
      >
        <DialogHeader>
          <DialogTitle className="text-base leading-snug">{question.title}</DialogTitle>
          {question.description ? (
            <DialogDescription>{question.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {required ? (
          <Input
            aria-label={required.label}
            placeholder={required.value}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && allowed) settle(question.id, "yes")
            }}
          />
        ) : null}
        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => settle(question.id, "no")}
          >
            {question.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={destructive ? "destructive" : "default"}
            size="sm"
            disabled={!allowed}
            onClick={() => settle(question.id, "yes")}
          >
            {question.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Draws the question the application is asking (docs/notices.md, section 9): one at a time, over whatever else
 * is open. Mounted once in App, outside the workspace. Escape and a click beside the window are "Cancel".
 */
export function ConfirmDialogHost() {
  const question = useConfirmStore((state) => state.queue[0])
  if (!question) return null
  return <ConfirmDialog key={question.id} question={question} />
}
