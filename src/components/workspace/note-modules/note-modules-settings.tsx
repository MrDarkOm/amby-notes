import * as React from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { AmbySelect } from "@/components/ui/amby-select"
import { isEnterKey } from "@/lib/keyboard"
import { listNoteTemplates, type NoteTemplate } from "@/lib/storage"
import { Row } from "../settings/settings-common"
import { NoticeLine } from "../notices/notice-line"
import {
  DEFAULT_DAILY_FOLDER,
  DEFAULT_TEMPLATES_FOLDER,
  loadNoteModuleSettings,
  normalizeModuleFolder,
  saveNoteModuleSetting,
} from "./note-module-settings"

const NO_TEMPLATE = ""

/**
 * A folder field saved when it loses focus or on Enter. An unacceptable path is not saved: the
 * field says so and keeps what the person typed.
 */
function FolderField({
  id,
  value,
  placeholder,
  rootAllowed,
  onSave,
}: {
  id: string
  value: string
  placeholder: string
  rootAllowed: boolean
  onSave: (folder: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = React.useState(value)
  const [problem, setProblem] = React.useState<"invalid" | "failed" | null>(null)
  React.useEffect(() => setDraft(value), [value])

  const commit = async () => {
    const folder = normalizeModuleFolder(draft || placeholder, rootAllowed)
    if (folder === null) {
      setProblem("invalid")
      return
    }
    setProblem(null)
    if (folder === value) {
      setDraft(folder)
      return
    }
    try {
      await onSave(folder)
      setDraft(folder)
    } catch {
      setProblem("failed")
    }
  }

  return (
    <div className="flex w-56 flex-col items-end gap-1">
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        className="h-8 font-mono text-[12px]"
        aria-invalid={problem !== null}
        onChange={(event) => {
          setDraft(event.target.value)
          setProblem(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (isEnterKey(event)) event.currentTarget.blur()
        }}
      />
      {problem && (
        <NoticeLine
          role="alert"
          text={t(problem === "invalid" ? "noteModules.folderInvalid" : "noteModules.saveFailed")}
        />
      )}
    </div>
  )
}

/** The Templates module's page in Settings → Modules. */
export function TemplatesModuleSettings() {
  const { t } = useTranslation()
  const [folder, setFolder] = React.useState(DEFAULT_TEMPLATES_FOLDER)
  React.useEffect(() => {
    let current = true
    loadNoteModuleSettings()
      .then((settings) => current && setFolder(settings.templates.folder))
      // Unreadable settings: the field shows the default and nothing is written.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [])
  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      <Row label={t("noteModules.templatesFolder")} hint={t("noteModules.templatesFolderHint")}>
        <FolderField
          id="templates-folder"
          value={folder}
          placeholder={DEFAULT_TEMPLATES_FOLDER}
          rootAllowed={false}
          onSave={async (next) => {
            await saveNoteModuleSetting("templates", "folder", next)
            setFolder(next)
          }}
        />
      </Row>
    </div>
  )
}

/** The Daily notes module's page in Settings → Modules. */
export function DailyModuleSettings() {
  const { t } = useTranslation()
  const [folder, setFolder] = React.useState(DEFAULT_DAILY_FOLDER)
  const [template, setTemplate] = React.useState<string | null>(null)
  const [templates, setTemplates] = React.useState<NoteTemplate[] | null>(null)
  const [templateFailed, setTemplateFailed] = React.useState(false)
  React.useEffect(() => {
    let current = true
    loadNoteModuleSettings()
      .then((settings) => {
        if (!current) return
        setFolder(settings.daily.folder)
        setTemplate(settings.daily.template)
      })
      // Unreadable settings: the fields show the defaults and nothing is written.
      .catch(() => {})
    // Without the Templates module (or outside the desktop app) there is nothing to pick from.
    listNoteTemplates()
      .then((items) => current && setTemplates(items))
      .catch(() => current && setTemplates([]))
    return () => {
      current = false
    }
  }, [])

  const options = [
    { value: NO_TEMPLATE, label: t("noteModules.noTemplate") },
    ...(templates ?? []).map((item) => ({ value: item.name, label: item.name })),
    // A saved template that is no longer listed stays visible, so it is not changed silently.
    ...(template && templates && !templates.some((item) => item.name === template)
      ? [{ value: template, label: t("noteModules.missingTemplate", { name: template }) }]
      : []),
  ]

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      <Row label={t("noteModules.dailyFolder")} hint={t("noteModules.dailyFolderHint")}>
        <FolderField
          id="daily-folder"
          value={folder}
          placeholder={DEFAULT_DAILY_FOLDER}
          rootAllowed
          onSave={async (next) => {
            await saveNoteModuleSetting("daily", "folder", next)
            setFolder(next)
          }}
        />
      </Row>
      <Row label={t("noteModules.dailyTemplate")} hint={t("noteModules.dailyTemplateHint")}>
        <div className="flex w-56 flex-col items-end gap-1">
          <AmbySelect
            value={template ?? NO_TEMPLATE}
            options={options}
            disabled={templates === null}
            title={t("noteModules.dailyTemplate")}
            onValueChange={(value) => {
              const next = value === NO_TEMPLATE ? null : value
              setTemplateFailed(false)
              saveNoteModuleSetting("daily", "template", next)
                .then(() => setTemplate(next))
                .catch(() => setTemplateFailed(true))
            }}
          />
          {templateFailed && <NoticeLine role="alert" text={t("noteModules.saveFailed")} />}
        </div>
      </Row>
    </div>
  )
}
