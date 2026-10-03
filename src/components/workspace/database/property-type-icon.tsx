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
  Type,
} from "lucide-react"

/** The small icon of a property type. */
export function PropertyTypeIcon({ type }: { type: string }) {
  const Icon =
    type === "text"
      ? AlignJustify
      : type === "number"
        ? Hash
        : type === "checkbox"
          ? CheckSquare
          : type === "date"
            ? CalendarDays
            : type === "url"
              ? Link2
              : type === "select"
                ? CircleChevronDown
                : type === "multiSelect"
                  ? List
                  : type === "status"
                    ? CircleDashed
                    : type === "relation"
                      ? ArrowUpRight
                      : type === "files"
                        ? Paperclip
                        : type === "formula"
                          ? Sigma
                          : type === "rollup"
                            ? Search
                            : Type
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
}
