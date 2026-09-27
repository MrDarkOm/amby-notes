"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Download, ExternalLink, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { confirmAction, exportTextFile, importTextFile } from "@/lib/storage"
import {
  BUILTIN_THEME_FAMILIES,
  BUILTIN_THEMES,
  builtinThemeFamilyForId,
  parseThemeDefinition,
  themeById,
  withUniqueThemeId,
  type BuiltinTheme,
  type ThemeDefinition,
  type ThemeModePreference,
} from "@/lib/themes"
import { Row, selectTrigger } from "./settings-common"

function builtinThemeName(theme: BuiltinTheme, t: (key: string) => string): string {
  const key: Record<BuiltinTheme["id"], string> = {
    dark: "settings.appearance.themeDark",
    light: "settings.appearance.themeLight",
    system: "settings.appearance.themeSystem",
    catppuccin: "settings.appearance.themeCatppuccin",
    "catppuccin-light": "settings.appearance.themeCatppuccin",
    gruvbox: "settings.appearance.themeMaterialGruvbox",
    "gruvbox-light": "settings.appearance.themeMaterialGruvbox",
  }
  return t(key[theme.id])
}

// This is a UI-only Select value. The leading underscores keep it outside the
// portable theme id grammar, so an imported theme can never collide with it.
const DEFAULT_THEME_FAMILY_ID = "__amby-default__"

function themeModeForFamily(
  family: { variants: Partial<Record<ThemeModePreference, BuiltinTheme["id"]>> },
  themeId: string,
): ThemeModePreference | null {
  const entry = (
    Object.entries(family.variants) as [ThemeModePreference, BuiltinTheme["id"]][]
  ).find(([, variantId]) => variantId === themeId)
  return entry?.[0] ?? null
}

const themeActionClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-foreground hover:bg-card"

export function ThemeLibrary({
  selectedThemeId,
  themes,
  onSelect,
  onThemesChange,
}: {
  selectedThemeId: string
  themes: ThemeDefinition[]
  onSelect: (id: string) => void
  onThemesChange: (themes: ThemeDefinition[]) => void
}) {
  const { t } = useTranslation()
  const [error, setError] = React.useState<string | null>(null)
  const selected = themeById(selectedThemeId, themes)
  const selectedCustomTheme = themes.find((theme) => theme.id === selected.id)
  const selectedFamily = builtinThemeFamilyForId(selected.id)
  const selectedMode = selectedFamily ? themeModeForFamily(selectedFamily, selected.id) : null

  function selectTheme(id: string) {
    const familyId = id === DEFAULT_THEME_FAMILY_ID ? "amby" : id
    const family = BUILTIN_THEME_FAMILIES.find((item) => item.id === familyId)
    if (family) {
      // Keep the current mode when switching palettes. If the new family does
      // not provide that mode, prefer dark and then the first available one.
      const nextId =
        (selectedMode && family.variants[selectedMode]) ??
        family.variants.dark ??
        Object.values(family.variants)[0]
      if (nextId) onSelect(nextId)
      return
    }
    onSelect(id)
  }

  function selectThemeMode(mode: string) {
    if (!selectedFamily) return
    const nextId = selectedFamily.variants[mode as ThemeModePreference]
    if (nextId) onSelect(nextId)
  }

  async function importTheme() {
    setError(null)
    try {
      const text = await importTextFile()
      if (!text) return
      const parsed = parseThemeDefinition(JSON.parse(text))
      if (!parsed) {
        setError(t("settings.appearance.themeImportFailed"))
        return
      }
      const theme = withUniqueThemeId(parsed, themes)
      onThemesChange([...themes, theme])
      onSelect(theme.id)
    } catch {
      setError(t("settings.appearance.themeImportFailed"))
    }
  }

  async function exportTheme(theme: ThemeDefinition) {
    try {
      await exportTextFile(`${JSON.stringify(theme, null, 2)}\n`, `${theme.id}.amby-theme.json`)
    } catch {
      // A cancelled native dialog intentionally leaves the library untouched.
    }
  }

  async function removeTheme(theme: ThemeDefinition) {
    if (!(await confirmAction(t("settings.appearance.themeRemoveConfirm", { name: theme.name }))))
      return
    onThemesChange(themes.filter((item) => item.id !== theme.id))
    if (selectedThemeId === theme.id) onSelect("dark")
  }

  return (
    <>
      <Row label={t("settings.appearance.theme")} hint={t("settings.appearance.themeLibraryHint")}>
        <div className="flex items-center gap-1.5">
          <Select
            value={
              selectedFamily?.id === "amby"
                ? DEFAULT_THEME_FAMILY_ID
                : (selectedFamily?.id ?? selected.id)
            }
            onValueChange={selectTheme}
          >
            <SelectTrigger className={selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t("settings.appearance.builtinThemes")}</SelectLabel>
                {BUILTIN_THEME_FAMILIES.map((family) => {
                  const variantId = family.variants.dark ?? family.variants.light
                  const theme = BUILTIN_THEMES.find((item) => item.id === variantId)
                  if (!theme) return null
                  return (
                    <SelectItem
                      key={family.id}
                      value={family.id === "amby" ? DEFAULT_THEME_FAMILY_ID : family.id}
                    >
                      {family.id === "amby"
                        ? t("settings.appearance.themeStandard")
                        : builtinThemeName(theme, t)}
                    </SelectItem>
                  )
                })}
              </SelectGroup>
              {themes.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>{t("settings.appearance.importedThemes")}</SelectLabel>
                    {themes.map((theme) => (
                      <SelectItem key={theme.id} value={theme.id}>
                        {theme.author
                          ? `${theme.name} · ${t("settings.appearance.themeAuthor", { author: theme.author })}`
                          : theme.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>

          {selectedCustomTheme && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={t("settings.appearance.exportTheme")}
                aria-label={t("settings.appearance.exportTheme")}
                onClick={() => void exportTheme(selectedCustomTheme)}
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title={t("settings.appearance.removeTheme")}
                aria-label={t("settings.appearance.removeTheme")}
                onClick={() => void removeTheme(selectedCustomTheme)}
                className="hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </Row>

      {selectedFamily && selectedMode && Object.keys(selectedFamily.variants).length > 1 && (
        <Row
          label={t("settings.appearance.themeMode")}
          hint={t("settings.appearance.themeModeHint")}
        >
          <Select value={selectedMode} onValueChange={selectThemeMode}>
            <SelectTrigger className={selectTrigger}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(selectedFamily.variants) as ThemeModePreference[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`settings.appearance.theme${mode[0].toUpperCase()}${mode.slice(1)}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}

      <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-3">
        <span className="text-[13px] text-foreground">
          {t("settings.appearance.importedThemes")}
        </span>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={themeActionClass} onClick={() => void importTheme()}>
            <Upload className="size-3.5" />
            {t("settings.appearance.importTheme")}
          </button>
          <a
            className={themeActionClass}
            href="https://github.com/search?q=amby-theme.json&type=code"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="size-3.5" />
            {t("settings.appearance.discoverThemes")}
          </a>
        </div>
      </div>
      {error && <p className="px-4 py-2 text-[11px] text-destructive">{error}</p>}
    </>
  )
}
