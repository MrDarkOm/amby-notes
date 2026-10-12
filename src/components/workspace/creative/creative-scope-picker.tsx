import { BookOpen, Check, ChevronDown } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ProjectSummary } from "@/lib/storage"
import { IconValue } from "../icon-value"
import { projectFallbackIcon } from "./section-icons"
import { STANDALONE_SCOPE } from "./project-tree-model"

function ProjectIcon({ project }: { project: ProjectSummary }) {
  const Fallback = projectFallbackIcon(project)
  return (
    <IconValue
      value={project.icon ?? undefined}
      fallback={<Fallback className="size-4" />}
      className="size-4"
    />
  )
}

interface CreativeScopePickerProps {
  /** The top-level collections, one choice each. */
  scopes: ProjectSummary[]
  /** The resolved scope: a collection's project ID, or `STANDALONE_SCOPE`. */
  current: string | null
  onSelect: (scope: string | null) => void
}

/** The switcher of the creative scopes, styled like the workspace switcher under the file tree. */
export function CreativeScopePicker({ scopes, current, onSelect }: CreativeScopePickerProps) {
  const { t } = useTranslation()
  const currentProject = scopes.find((scope) => scope.projectId === current) ?? null
  const caption = currentProject
    ? t(currentProject.sections.length > 0 ? "creative.kind.universe" : "creative.kind.collection")
    : t("creative.scope.caption")
  const name = currentProject?.name ?? t("creative.scope.standalone")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("creative.scope.switch")}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-background/70 px-3 py-2.5 text-left outline-none hover:bg-accent"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {currentProject ? (
              <ProjectIcon project={currentProject} />
            ) : (
              <BookOpen className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block whitespace-nowrap text-[8px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {caption}
            </span>
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 border-border bg-popover text-foreground">
        {scopes.map((scope) => (
          <DropdownMenuItem
            key={scope.projectId}
            className="relative flex items-center gap-2 pr-8 text-[13px] focus:bg-accent focus:text-white"
            onSelect={() => onSelect(scope.projectId)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              <ProjectIcon project={scope} />
            </span>
            <span className="min-w-0 flex-1 truncate">{scope.name}</span>
            {current === scope.projectId && (
              <Check className="absolute right-2 size-3.5 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        {scopes.length > 0 && <DropdownMenuSeparator className="bg-accent" />}
        <DropdownMenuItem
          className="relative flex items-center gap-2 pr-8 text-[13px] focus:bg-accent focus:text-white"
          onSelect={() => onSelect(STANDALONE_SCOPE)}
        >
          <BookOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("creative.scope.standalone")}</span>
          {current === STANDALONE_SCOPE && (
            <Check className="absolute right-2 size-3.5 text-primary" />
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
