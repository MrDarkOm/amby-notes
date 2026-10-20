import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, MoreVertical } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { PageMenuGroup, PageMenuItem } from "./page-chrome-types"

const ROW = "flex items-center gap-2 text-[13px]"
const ROW_NORMAL = `${ROW} focus:bg-accent focus:text-white`
const ROW_DESTRUCTIVE = `${ROW} text-red-400 focus:bg-accent focus:text-red-300`

/** The groups that have rows, so no separator stands at an end or twice in a row. */
function shownGroups(groups: PageMenuGroup[]): PageMenuGroup[] {
  return groups.filter((group) => group.length > 0)
}

function ItemBody({ item }: { item: PageMenuItem }) {
  const marked = item.checked === true
  return (
    <>
      {item.icon}
      {item.checked === undefined && !item.growLabel ? (
        item.label
      ) : (
        <>
          <span className="flex-1">{item.label}</span>
          {marked && item.checkStyle === "icon" ? (
            <Check className="size-3.5 text-primary" />
          ) : marked ? (
            <span className="text-primary">✓</span>
          ) : null}
        </>
      )}
    </>
  )
}

function MenuItems({ groups }: { groups: PageMenuGroup[] }) {
  const shown = shownGroups(groups)
  return (
    <>
      {shown.map((group, index) => (
        <React.Fragment key={group.map((item) => item.id).join("|") || index}>
          {index > 0 && <DropdownMenuSeparator className="bg-accent" />}
          {group.map((item) =>
            item.submenu ? (
              <DropdownMenuSub key={item.id}>
                <DropdownMenuSubTrigger
                  disabled={item.disabled}
                  className={`${ROW_NORMAL} data-[state=open]:bg-accent`}
                >
                  {item.icon}
                  {item.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className={`${item.submenuWidth ?? "w-48"} border-border bg-popover text-foreground`}
                >
                  <MenuItems groups={item.submenu} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem
                key={item.id}
                disabled={item.disabled}
                className={item.destructive ? ROW_DESTRUCTIVE : ROW_NORMAL}
                onSelect={() => item.onSelect?.()}
              >
                <ItemBody item={item} />
              </DropdownMenuItem>
            ),
          )}
        </React.Fragment>
      ))}
    </>
  )
}

interface PageMenuProps {
  groups: PageMenuGroup[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** The "⋯" button of a page and its menu, built from the groups the surface hands in. */
export function PageMenu({ groups, open, onOpenChange }: PageMenuProps) {
  const { t } = useTranslation()
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("docEditor.moreActions")}
          title={t("docEditor.moreActions")}
          className="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <MoreVertical className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 border-border bg-popover text-foreground">
        <MenuItems groups={groups} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
