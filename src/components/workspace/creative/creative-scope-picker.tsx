import { Check, ChevronDown, Feather } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { WorkshopSummary } from "@/lib/storage"
import { IconValue } from "../icon-value"

function WorkshopIcon({ workshop }: { workshop: WorkshopSummary }) {
  return (
    <IconValue
      value={workshop.icon ?? undefined}
      fallback={<Feather className="size-4" />}
      className="size-4"
    />
  )
}

interface CreativeScopePickerProps {
  /** The workshops in the vault. */
  scopes: WorkshopSummary[]
  /** The active workshop ID. */
  current: string | null
  onSelect: (scope: string | null) => void
}

/** The switcher of the creative workshops in the vault. */
export function CreativeScopePicker({ scopes, current, onSelect }: CreativeScopePickerProps) {
  const { t } = useTranslation()
  const currentWorkshop = scopes.find((scope) => scope.workshopId === current) ?? scopes[0] ?? null
  const name = currentWorkshop?.name ?? t("creative.welcome.title", "Мастерская")

  if (scopes.length <= 1) {
    return (
      <div className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/70 px-3 py-2 text-left">
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {currentWorkshop ? (
            <WorkshopIcon workshop={currentWorkshop} />
          ) : (
            <Feather className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("creative.welcome.title", "Мастерская")}
          </span>
          <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        </span>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("creative.scope.switch", "Выбрать мастерскую")}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/70 px-3 py-2.5 text-left outline-none hover:bg-accent"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {currentWorkshop ? (
              <WorkshopIcon workshop={currentWorkshop} />
            ) : (
              <Feather className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {t("creative.welcome.title", "Мастерская")}
            </span>
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 border-border bg-popover text-foreground">
        {scopes.map((scope) => (
          <DropdownMenuItem
            key={scope.workshopId}
            className="relative flex items-center gap-2 pr-8 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onSelect(scope.workshopId)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              <WorkshopIcon workshop={scope} />
            </span>
            <span className="min-w-0 flex-1 truncate">{scope.name}</span>
            {current === scope.workshopId && (
              <Check className="absolute right-2 size-3.5 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
