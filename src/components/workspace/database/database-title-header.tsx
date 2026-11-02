import * as React from "react"

import { Database } from "lucide-react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"

import { motionTransitions } from "@/lib/motion-config"

import { EmojiPickerPanel } from "../tiptap/EmojiPickerPanel"
import { IconValue } from "../icon-value"

interface DatabaseTitleHeaderProps {
  iconTriggerRef: React.RefObject<HTMLButtonElement | null>
  setIconPickerOpen: React.Dispatch<React.SetStateAction<boolean>>
  displayedDatabaseIcon: string | undefined
  iconPickerOpen: boolean
  setDatabaseIcon: React.Dispatch<React.SetStateAction<string>>
  onIconChange: ((icon: string) => void) | undefined
  databaseTitle: string
  editingDatabaseTitle: boolean
  setEditingDatabaseTitle: React.Dispatch<React.SetStateAction<boolean>>
  setDatabaseTitle: React.Dispatch<React.SetStateAction<string>>
  commitDatabaseTitle: () => void
  title: string
}

export function DatabaseTitleHeader({
  iconTriggerRef,
  setIconPickerOpen,
  displayedDatabaseIcon,
  iconPickerOpen,
  setDatabaseIcon,
  onIconChange,
  databaseTitle,
  editingDatabaseTitle,
  setEditingDatabaseTitle,
  setDatabaseTitle,
  commitDatabaseTitle,
  title,
}: DatabaseTitleHeaderProps) {
  const { t } = useTranslation()
  return (
    <header className="flex shrink-0 items-center gap-3 px-0 py-4">
      <div className="relative shrink-0">
        <motion.button
          ref={iconTriggerRef}
          type="button"
          className="text-3xl leading-none focus:outline-none dark:text-foreground"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.96 }}
          transition={motionTransitions.default}
          title={t("databaseWorkspace.changeIcon")}
          aria-label={t("databaseWorkspace.changeIcon")}
          onClick={() => setIconPickerOpen((open) => !open)}
        >
          <IconValue
            value={displayedDatabaseIcon}
            fallback={<Database className="size-8" strokeWidth={1.7} />}
            className="size-8 rounded-md"
          />
        </motion.button>
        {iconPickerOpen && (
          <div className="absolute left-0 top-full z-50 mt-1">
            <EmojiPickerPanel
              triggerRef={iconTriggerRef}
              onSelect={(next) => {
                setDatabaseIcon(next.native)
                onIconChange?.(next.native)
                setIconPickerOpen(false)
              }}
              onClear={() => {
                setDatabaseIcon("")
                onIconChange?.("")
                setIconPickerOpen(false)
              }}
              clearLabel={t("tree.resetIcon")}
              onClose={() => setIconPickerOpen(false)}
            />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center">
        <input
          value={databaseTitle}
          readOnly={!editingDatabaseTitle}
          aria-label={t("databaseWorkspace.renameTitle")}
          onFocus={() => {
            if (!editingDatabaseTitle) setEditingDatabaseTitle(true)
          }}
          onChange={(event) => setDatabaseTitle(event.target.value)}
          onBlur={commitDatabaseTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDatabaseTitle()
            if (event.key === "Escape") {
              setDatabaseTitle(title)
              setEditingDatabaseTitle(false)
            }
          }}
          className="h-8 min-w-0 w-full cursor-text border-0 bg-transparent p-0 text-2xl font-semibold leading-none tracking-tight text-foreground outline-none sm:h-10 sm:text-3xl"
        />
      </div>
    </header>
  )
}
