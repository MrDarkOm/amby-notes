import { Maximize2, PanelBottom } from "lucide-react"
import type { TFunction } from "i18next"

import type { ContentWidth } from "../app-config"
import { useSettingsStore } from "../use-settings-store"
import type { PageMenuItem } from "./page-chrome-types"

export const CONTENT_WIDTHS: readonly ContentWidth[] = ["normal", "wide", "full"]

/** "Content width": the submenu every page offers, with the same three values as a note. */
export function contentWidthMenuItem(
  t: TFunction,
  current: ContentWidth,
  onChange: (width: ContentWidth) => void,
  disabled = false,
): PageMenuItem {
  return {
    id: "content-width",
    label: t("settings.editor.contentWidth"),
    icon: <Maximize2 className="size-3.5 text-muted-foreground" />,
    submenuWidth: "w-44",
    submenu: [
      CONTENT_WIDTHS.map((width) => ({
        id: `content-width-${width}`,
        label: t(`settings.editor.${width}`),
        checked: current === width,
        disabled,
        onSelect: () => onChange(width),
      })),
    ],
  }
}

/**
 * "Hide / Show the bottom bar": the one preference (`editor.showAreaControls`) behind the
 * floating bar of every page, so a bar hidden on a note can be brought back from a workshop page.
 */
export function bottomBarMenuItem(t: TFunction, shown: boolean, disabled = false): PageMenuItem {
  return {
    id: "bottom-bar",
    growLabel: true,
    label: shown ? t("docEditor.hideBottomBar") : t("docEditor.showBottomBar"),
    icon: <PanelBottom className="size-3.5 text-muted-foreground" />,
    disabled,
    onSelect: () => {
      const currentEditor = useSettingsStore.getState().prefs.editor
      void useSettingsStore.getState().setPrefs({
        editor: { ...currentEditor, showAreaControls: !(currentEditor.showAreaControls ?? true) },
      })
    },
  }
}
