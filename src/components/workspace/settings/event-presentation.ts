import type { LogLevel } from "@/lib/debug/types"

type EventLabelKey =
  | "settings.debug.eventLabel.error"
  | "settings.debug.eventLabel.queue"
  | "settings.debug.eventLabel.search"
  | "settings.debug.eventLabel.index"
  | "settings.debug.eventLabel.watcher"
  | "settings.debug.eventLabel.read"
  | "settings.debug.eventLabel.save"
  | "settings.debug.eventLabel.operation"

export function eventLabelKey(event: string, level: LogLevel): EventLabelKey {
  const code = event.toLocaleLowerCase()
  if (level === "error" || /(^|[._-])(error|failed|failure|conflict)([._-]|$)/u.test(code)) {
    return "settings.debug.eventLabel.error"
  }
  if (/(^|[._-])(queue|queued|pending|flush|drain)([._-]|$)/u.test(code)) {
    return "settings.debug.eventLabel.queue"
  }
  if (/(^|[._-])(search|query)([._-]|$)/u.test(code)) {
    return "settings.debug.eventLabel.search"
  }
  if (/(^|[._-])(index|reindex|indexed)([._-]|$)/u.test(code)) {
    return "settings.debug.eventLabel.index"
  }
  if (/(^|[._-])(watch|watcher|external)([._-]|$)/u.test(code)) {
    return "settings.debug.eventLabel.watcher"
  }
  if (/(^|[._-])(read|load|open|resolve)([._-]|$)/u.test(code)) {
    return "settings.debug.eventLabel.read"
  }
  if (
    /(^|[._-])(write|save|persist|create|delete|restore|rename|move|autosave)([._-]|$)/u.test(code)
  ) {
    return "settings.debug.eventLabel.save"
  }
  return "settings.debug.eventLabel.operation"
}
