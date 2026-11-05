import {
  AlignJustify,
  ArrowUpRight,
  CalendarDays,
  CheckSquare,
  CircleChevronDown,
  CircleDashed,
  Hash,
  Link2,
  List,
  Paperclip,
  Search,
  Sigma,
  type LucideIcon,
} from "lucide-react"

/**
 * The one mapping «type of a property → Lucide icon», for the panel of a note and for databases
 * (docs/sync-plan.md, З61). The name is the one `icon-values.ts` writes as `amby-icon:<name>:`.
 */
const TYPE_ICONS: Record<string, { name: string; Icon: LucideIcon }> = {
  text: { name: "align-justify", Icon: AlignJustify },
  number: { name: "hash", Icon: Hash },
  checkbox: { name: "square-check", Icon: CheckSquare },
  date: { name: "calendar-days", Icon: CalendarDays },
  url: { name: "link-2", Icon: Link2 },
  select: { name: "circle-chevron-down", Icon: CircleChevronDown },
  list: { name: "list", Icon: List },
  multiSelect: { name: "list", Icon: List },
  status: { name: "circle-dashed", Icon: CircleDashed },
  relation: { name: "arrow-up-right", Icon: ArrowUpRight },
  files: { name: "paperclip", Icon: Paperclip },
  formula: { name: "sigma", Icon: Sigma },
  rollup: { name: "search", Icon: Search },
}

export function propertyTypeIcon(type: string): LucideIcon {
  return (TYPE_ICONS[type] ?? TYPE_ICONS.text).Icon
}

export function propertyTypeIconName(type: string): string {
  return (TYPE_ICONS[type] ?? TYPE_ICONS.text).name
}
