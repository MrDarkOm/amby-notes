import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { ChevronDown, Search } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { motionTransition, motionTransitions } from "@/lib/motion-config"
import { formatShortcut, SHORTCUT_DEFINITIONS } from "./keyboard-shortcuts"
import { useSettingsStore } from "./use-settings-store"
import type { HelpContext } from "./help-modal"

const CONTEXTS: HelpContext[] = ["note", "canvas", "sketch", "database", "workspace"]

export function HelpShortcuts({ context }: { context: HelpContext }) {
  const { t } = useTranslation()
  const bindings = useSettingsStore((state) => state.prefs.shortcuts)
  const [tab, setTab] = React.useState(context)
  const [query, setQuery] = React.useState("")
  const [collapsed, setCollapsed] = React.useState(
    () => localStorage.getItem("amby:help-shortcuts-collapsed") === "1",
  )
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem("amby:help-shortcuts-collapsed", next ? "1" : "0")
  }
  const bodyId = React.useId()
  const mac = /Mac/i.test(navigator.platform)
  const key = (binding: string) => formatShortcut(binding, mac)
  const item = (binding: string, labelKey: string) => ({ key: key(binding), label: t(labelKey) })
  const syntax = (keys: string, labelKey: string) => ({ key: keys, label: t(labelKey) })
  const items = (() => {
    switch (tab) {
      case "note":
        return [
          item("Mod+B", "help.note.bold"),
          item("Mod+I", "help.note.italic"),
          item("Mod+U", "help.note.underline"),
          item("Mod+Shift+X", "help.note.strikethrough"),
          item("Mod+E", "help.note.code"),
          item("Mod+K", "help.note.link"),
          syntax("# … ######", "help.note.headings"),
          syntax("- / * + Space", "help.note.bulletList"),
          syntax("1. + Space", "help.note.numberedList"),
          syntax("[ ] + Space", "help.note.taskList"),
          syntax("> + Space", "help.note.quote"),
          syntax("``` + Space", "help.note.codeBlock"),
          syntax("---", "help.note.divider"),
          syntax(`${key("Mod+Z")} / ${key("Mod+Shift+Z")}`, "help.note.undoRedo"),
        ]
      case "canvas":
        return [
          syntax("V", "canvas.hotkeySelect"),
          syntax("H", "canvas.hotkeyHand"),
          syntax("Space", "canvas.hotkeySpace"),
          item("Mod+Z", "canvas.hotkeyUndo"),
          item(mac ? "Mod+Shift+Z" : "Mod+Y", "canvas.hotkeyRedo"),
          item("Mod+D", "canvas.hotkeyDuplicate"),
          syntax(`${key("Mod+C")} / ${key("Mod+V")}`, "canvas.hotkeyCopyPaste"),
          syntax(mac ? "⌫" : "Delete", "canvas.hotkeyDelete"),
          syntax(t("help.guide.doubleClick"), "canvas.hotkeyEditLabel"),
          syntax(t("help.guide.doubleClick"), "canvas.hotkeyOpenNote"),
        ]
      case "sketch":
        return [
          syntax("V / 1", "help.sketch.select"),
          syntax("H", "help.sketch.hand"),
          syntax("Space", "help.sketch.space"),
          syntax("R / 2", "help.sketch.rectangle"),
          syntax("D / 3", "help.sketch.diamond"),
          syntax("E / 4", "help.sketch.ellipse"),
          syntax("A / 5", "help.sketch.arrow"),
          syntax("L / 6", "help.sketch.line"),
          syntax("P / 7", "help.sketch.pen"),
          syntax("T / 8", "help.sketch.text"),
          syntax("0 / 9", "help.sketch.eraser"),
          syntax(`${key("Mod+Z")} / ${key("Mod+Shift+Z")}`, "help.sketch.undoRedo"),
          item("Mod+D", "help.sketch.duplicate"),
          syntax(mac ? "⌫" : "Delete", "help.sketch.delete"),
        ]
      case "database":
        return [
          syntax("Space / Enter", "help.database.openRow"),
          syntax("Enter", "help.database.editCell"),
          syntax("Tab / ⇧Tab", "help.database.navigate"),
          syntax("Esc", "help.database.cancel"),
          item("Mod+F", "help.database.search"),
        ]
      default:
        return SHORTCUT_DEFINITIONS.map((definition) =>
          item(bindings[definition.id], definition.labelKey),
        )
    }
  })()
  const normalized = query.trim().toLocaleLowerCase()
  const visible = items.filter((entry) =>
    `${entry.label} ${entry.key}`.toLocaleLowerCase().includes(normalized),
  )

  return (
    <section className="amby-help-shortcuts" aria-label={t("help.guide.shortcuts")}>
      <button
        type="button"
        className="amby-help-section-label amby-help-section-toggle"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        title={t(collapsed ? "help.guide.expandShortcuts" : "help.guide.collapseShortcuts")}
        onClick={toggle}
      >
        <span>{t("help.guide.shortcuts")}</span>
        <span className="amby-help-toggle-action">
          {t(collapsed ? "help.guide.expand" : "help.guide.collapse")}
          <motion.span
            aria-hidden="true"
            className="inline-flex"
            initial={false}
            animate={{ rotate: collapsed ? -90 : 0 }}
            transition={motionTransition(motionTransitions.default)}
          >
            <ChevronDown size={14} />
          </motion.span>
        </span>
      </button>
      <TabsPrimitive.Root
        id={bodyId}
        hidden={collapsed}
        value={tab}
        onValueChange={(value) => setTab(value as HelpContext)}
      >
        <TabsPrimitive.List
          className="amby-help-tabs"
          aria-label={t("help.guide.shortcutCategory")}
        >
          {CONTEXTS.map((value) => (
            <TabsPrimitive.Trigger key={value} value={value} className="amby-help-tab">
              {t(`help.tabs.${value === "workspace" ? "general" : value}`)}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        <label className="amby-help-search">
          <Search aria-hidden="true" size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("help.guide.searchShortcuts")}
            aria-label={t("help.guide.searchShortcuts")}
          />
        </label>
        {CONTEXTS.map((value) => (
          <TabsPrimitive.Content
            key={value}
            value={value}
            className="amby-help-shortcut-list"
            tabIndex={0}
          >
            {visible.length ? (
              visible.map((entry) => (
                <div key={entry.label} className="amby-help-shortcut-row">
                  <span>{entry.label}</span>
                  <kbd>{entry.key}</kbd>
                </div>
              ))
            ) : (
              <p className="amby-help-empty">{t("help.guide.noShortcuts")}</p>
            )}
          </TabsPrimitive.Content>
        ))}
      </TabsPrimitive.Root>
    </section>
  )
}
