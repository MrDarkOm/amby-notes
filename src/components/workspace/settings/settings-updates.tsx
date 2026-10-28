import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { AmbySelect } from "@/components/ui/amby-select"
import { MotionSpinner } from "@/lib/motion"
import {
  checkForAppUpdate,
  getCurrentAppVersion,
  isAppUpdaterAvailable,
  type AvailableAppUpdate,
  type UpdateInstallProgress,
} from "@/lib/app-updater"
import { openWebAddressInBrowser } from "../tiptap/external-open"
import { useSettingsStore } from "../use-settings-store"
import { Row } from "./settings-common"
import type { UpdateChannelPref } from "../app-config"

const SOURCE_CODE_URL = "https://github.com/MrDarkOm/amby-notes"

type UpdateUiState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; percent: number | null }
  | { phase: "installing" | "restarting" }
  | { phase: "error" }

export function UpdateSettings() {
  const { t } = useTranslation()
  const prefs = useSettingsStore((state) => state.prefs)
  const setPrefs = useSettingsStore((state) => state.setPrefs)
  const supported = isAppUpdaterAvailable()
  const [version, setVersion] = React.useState("…")
  const [update, setUpdate] = React.useState<AvailableAppUpdate | null>(null)
  const [state, setState] = React.useState<UpdateUiState>({ phase: "idle" })
  const [channel, setChannel] = React.useState<UpdateChannelPref>(prefs.updates.channel)
  const channelRef = React.useRef(channel)
  const prefsChannelRef = React.useRef(prefs.updates.channel)
  const checkGenerationRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  const foundChannelRef = React.useRef<UpdateChannelPref | null>(null)
  const installingUpdateRef = React.useRef<AvailableAppUpdate | null>(null)

  // Keep refs current during render so a completed request cannot publish an
  // obsolete result between an external settings update and its effect.
  prefsChannelRef.current = prefs.updates.channel

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      checkGenerationRef.current += 1
    }
  }, [])

  React.useEffect(() => {
    void getCurrentAppVersion().then(setVersion)
  }, [])

  React.useEffect(() => {
    return () => {
      if (update && installingUpdateRef.current !== update) {
        foundChannelRef.current = null
        void update.close().catch(() => {})
      }
    }
  }, [update])

  React.useEffect(() => {
    if (channel === prefs.updates.channel) return
    channelRef.current = prefs.updates.channel
    setChannel(prefs.updates.channel)
    if (update && installingUpdateRef.current === update) return
    checkGenerationRef.current += 1
    foundChannelRef.current = null
    setUpdate(null)
    setState({ phase: "idle" })
  }, [channel, prefs.updates.channel, update])

  const checkNow = async () => {
    const requestedChannel = channelRef.current
    const generation = ++checkGenerationRef.current
    setState({ phase: "checking" })
    try {
      const next = await checkForAppUpdate(requestedChannel)
      if (
        !mountedRef.current ||
        generation !== checkGenerationRef.current ||
        requestedChannel !== channelRef.current ||
        requestedChannel !== prefsChannelRef.current
      ) {
        await next?.close().catch(() => {})
        return
      }
      foundChannelRef.current = next ? requestedChannel : null
      setUpdate(next)
      setState(next ? { phase: "available", version: next.version } : { phase: "current" })
    } catch {
      if (
        !mountedRef.current ||
        generation !== checkGenerationRef.current ||
        requestedChannel !== channelRef.current ||
        requestedChannel !== prefsChannelRef.current
      )
        return
      setUpdate(null)
      setState({ phase: "error" })
    }
  }

  const changeChannel = (nextChannel: UpdateChannelPref) => {
    if (nextChannel === channelRef.current) return
    channelRef.current = nextChannel
    setChannel(nextChannel)
    const installingUpdate = installingUpdateRef.current
    if (!installingUpdate) {
      checkGenerationRef.current += 1
      foundChannelRef.current = null
      setUpdate(null)
      setState({ phase: "idle" })
    }
    void setPrefs({ updates: { ...prefs.updates, channel: nextChannel } })
  }

  const install = async () => {
    if (!update) return
    const updateChannel = foundChannelRef.current
    if (
      !updateChannel ||
      updateChannel !== channelRef.current ||
      updateChannel !== prefsChannelRef.current
    ) {
      foundChannelRef.current = null
      setUpdate(null)
      setState({ phase: "idle" })
      return
    }
    installingUpdateRef.current = update
    setState({ phase: "installing" })
    const onProgress = (progress: UpdateInstallProgress) => setState(progress)
    try {
      await update.install(onProgress)
      installingUpdateRef.current = null
      if (!mountedRef.current) {
        await update.close().catch(() => {})
        return
      }
      if (updateChannel !== channelRef.current || updateChannel !== prefsChannelRef.current) {
        foundChannelRef.current = null
        setUpdate(null)
        setState({ phase: "restarting" })
        return
      }
      setState({ phase: "restarting" })
    } catch {
      installingUpdateRef.current = null
      if (!mountedRef.current) {
        await update.close().catch(() => {})
        return
      }
      if (updateChannel !== channelRef.current || updateChannel !== prefsChannelRef.current) {
        foundChannelRef.current = null
        setUpdate(null)
      }
      setState({ phase: "error" })
    }
  }

  const status = !supported
    ? t("settings.updates.installedOnly")
    : state.phase === "checking"
      ? t("settings.updates.checking")
      : state.phase === "current"
        ? t("settings.updates.current")
        : state.phase === "available"
          ? t("settings.updates.available", { version: state.version })
          : state.phase === "downloading"
            ? state.percent === null
              ? t("settings.updates.downloading")
              : t("settings.updates.downloadingProgress", { progress: state.percent })
            : state.phase === "installing"
              ? t("settings.updates.installing")
              : state.phase === "restarting"
                ? t("settings.updates.restarting")
                : state.phase === "error"
                  ? t("settings.updates.error")
                  : t("settings.updates.checkHint")
  const busy = ["checking", "downloading", "installing", "restarting"].includes(state.phase)

  return (
    <>
      <Row label={t("settings.updates.autoUpdate")} hint={t("settings.updates.autoUpdateHint")}>
        <Switch
          checked={prefs.updates.autoUpdate}
          onCheckedChange={(autoUpdate) => setPrefs({ updates: { ...prefs.updates, autoUpdate } })}
        />
      </Row>
      <Row
        label={t("settings.updates.channel")}
        hint={
          channel === "stable"
            ? t("settings.updates.stableChannelHint")
            : t("settings.updates.betaChannelHint")
        }
      >
        <AmbySelect
          aria-label={t("settings.updates.channel")}
          value={channel}
          className="w-44"
          onValueChange={(value) => changeChannel(value as UpdateChannelPref)}
          options={[
            { value: "stable", label: t("settings.updates.channelStable") },
            { value: "beta", label: t("settings.updates.channelBeta") },
          ]}
        />
      </Row>
      <Row label={t("settings.updates.currentVersion")}>
        <span className="text-[13px] tabular-nums text-muted-foreground">{version}</span>
      </Row>
      <Row label={t("settings.updates.check")} hint={status}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!supported || busy}
          onClick={() => void (update ? install() : checkNow())}
        >
          {busy && (
            <MotionSpinner>
              <Loader2 className="size-3.5" />
            </MotionSpinner>
          )}
          {update
            ? t("settings.updates.install", { version: update.version })
            : t("settings.updates.checkAction")}
        </Button>
      </Row>
      <Row label={t("settings.updates.license")} hint={t("settings.updates.licenseHint")}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void openWebAddressInBrowser(SOURCE_CODE_URL)}
        >
          {t("settings.updates.sourceAction")}
        </Button>
      </Row>
    </>
  )
}
