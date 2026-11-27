import * as React from "react"
import { Anchor, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DatabaseRow } from "@/lib/storage"
import { InlineCreateRow } from "../workshop/inline-create-row"

export function AnchorBindingPicker({
  ahead,
  placed,
  compact,
  onBind,
  onCreate,
}: {
  ahead: DatabaseRow[]
  placed: DatabaseRow[]
  compact: boolean
  onBind: (anchorId: string) => Promise<void>
  onCreate: ((title: string) => Promise<void>) | null
}) {
  const { t } = useTranslation()
  const [naming, setNaming] = React.useState(false)
  const [binding, setBinding] = React.useState(false)
  const creating = React.useRef(false)
  const bind = async (id: string) => {
    setBinding(true)
    try {
      await onBind(id)
    } finally {
      setBinding(false)
    }
  }
  const option = (row: DatabaseRow) => (
    <DropdownMenuItem key={row.noteId} onSelect={() => void bind(row.noteId)}>
      <span className="truncate">{row.title}</span>
    </DropdownMenuItem>
  )

  if (naming && onCreate) {
    return (
      <InlineCreateRow
        depth={0}
        icon={<Anchor className="size-3.5" />}
        placeholder={t("creative.plot.ribbon.creating")}
        onCancel={() => setNaming(false)}
        onSubmit={async (title) => {
          await onCreate(title)
          setNaming(false)
        }}
      />
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={binding}
          className="w-fit text-xs"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {t(compact ? "creative.plot.side.bind" : "creative.plot.side.bindAnchor")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="max-h-64 w-52 overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (creating.current) event.preventDefault()
          creating.current = false
        }}
      >
        {ahead.length > 0 && (
          <>
            <DropdownMenuLabel>{t("creative.plot.ahead")}</DropdownMenuLabel>
            {ahead.map(option)}
            {placed.length > 0 && <DropdownMenuSeparator />}
          </>
        )}
        {placed.map(option)}
        {onCreate && (
          <>
            {(ahead.length > 0 || placed.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={() => {
                creating.current = true
                setNaming(true)
              }}
            >
              {t("creative.plot.side.newAnchor")}
            </DropdownMenuItem>
          </>
        )}
        {!onCreate && ahead.length + placed.length === 0 && (
          <DropdownMenuItem disabled>{t("creative.plot.menu.noAnchors")}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
