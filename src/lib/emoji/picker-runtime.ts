import { Picker } from "emoji-mart"
import { notoPickerData, installPickerImageFallback } from "./picker-data"
import { configurePickerSearch } from "./picker-search"
import { installPickerStyles } from "./picker-styles"

export interface PickerSetup {
  language: string
  theme: "dark" | "light"
  i18n: Record<string, unknown>
}
interface PickerElement extends HTMLElement {
  update(props: Record<string, unknown>): void
  connectedCallback(): void | Promise<void>
  disconnectedCallback(): void
  retained: boolean
}
const tag = "amby-emoji-picker"
let parking: HTMLDivElement | undefined
interface Entry {
  key: string
  picker: PickerElement
  owner?: symbol
  select?: (emoji: { native: string }) => void
  close?: () => void
  disposeStyles: () => void
  disposeFallback: () => void
}
let cached: Entry | undefined

function parkingPlace() {
  if (!parking) {
    parking = document.createElement("div")
    parking.className = "amby-emoji-picker-parking"
    parking.setAttribute("aria-hidden", "true")
    document.body.append(parking)
  }
  return parking
}

function constructor() {
  const registered = customElements.get(tag)
  if (registered)
    return registered as unknown as new (props: Record<string, unknown>) => PickerElement
  const Base = Picker as unknown as new (props: Record<string, unknown>) => PickerElement
  // Mart's default disconnect permanently unregisters the component. A retained
  // instance only moves between this document's hidden parking place and its
  // active mount, so keep the mounted component alive until explicit disposal.
  // No private component fields or methods are accessed.
  class RetainedPicker extends Base {
    retained = true
    private connectedOnce = false
    connectedCallback() {
      if (this.connectedOnce) return
      this.connectedOnce = true
      return super.connectedCallback()
    }
    disconnectedCallback() {
      if (!this.retained) super.disconnectedCallback()
    }
  }
  customElements.define(tag, RetainedPicker)
  return RetainedPicker
}

function disposeEntry(entry: Entry) {
  entry.owner = undefined
  entry.select = undefined
  entry.close = undefined
  entry.disposeStyles()
  entry.disposeFallback()
  entry.picker.retained = false
  entry.picker.remove()
}

function entryFor(setup: PickerSetup): Entry {
  const key = JSON.stringify([setup.language, setup.theme, setup.i18n])
  if (cached?.key === key) return cached
  if (cached) {
    const previous = cached
    cached = undefined
    const close = previous.close
    disposeEntry(previous)
    close?.()
  }
  configurePickerSearch(notoPickerData, setup.language)
  const Element = constructor()
  const entry = {} as Entry
  const picker = new Element({
    data: notoPickerData,
    i18n: setup.i18n,
    theme: setup.theme,
    onEmojiSelect: (emoji: { native: string }) => entry.select?.(emoji),
    previewPosition: "none",
    skinTonePosition: "search",
    navPosition: "bottom",
    set: "google",
    getSpritesheetURL: () => "",
    dynamicWidth: true,
  })
  picker.dataset.ambyEmojiPicker = "true"
  Object.assign(entry, {
    key,
    picker,
    disposeStyles: installPickerStyles(picker.shadowRoot!),
    disposeFallback: installPickerImageFallback(picker.shadowRoot!),
  })
  cached = entry
  return entry
}

/** Warm one bounded, invisible grid while the workspace is idle. */
export function warmEmojiPicker(setup: PickerSetup) {
  if (cached?.owner) return
  const entry = entryFor(setup)
  if (!entry.picker.isConnected) parkingPlace().append(entry.picker)
}

/** Reuse the same DOM and decoded images; a cold click gets a shell paint first. */
export function mountEmojiPicker(
  mount: HTMLElement,
  setup: PickerSetup,
  onSelect: (emoji: { native: string }) => void,
  onClose: () => void,
  refreshOnRelease: () => boolean = () => true,
): () => void {
  const owner = Symbol()
  let entry: Entry | undefined
  const attach = () => {
    entry = entryFor(setup)
    const previousClose = entry.close
    entry.owner = owner
    entry.select = onSelect
    entry.close = onClose
    previousClose?.()
    mount.replaceChildren(entry.picker)
  }
  const frame = cached ? undefined : requestAnimationFrame(attach)
  if (cached) attach()
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (!entry || entry.owner !== owner) return
    entry.owner = undefined
    entry.select = undefined
    entry.close = undefined
    const root = entry.picker.shadowRoot
    const search = root?.querySelector<HTMLInputElement>('input[type="search"]')
    if (search?.value) {
      search.value = ""
      search.dispatchEvent(new Event("input", { bubbles: true }))
    }
    root
      ?.querySelector(".menu")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    const scroll = root?.querySelector(".scroll")
    if (scroll) scroll.scrollTop = 0
    // Public categories update refreshes Mart's frequent grid while hidden. Its
    // deferred update runs after the selection event has saved the recent choice.
    if (refreshOnRelease()) entry.picker.update({ categories: null })
    parkingPlace().append(entry.picker)
  }
}

export function disposeEmojiPicker() {
  if (cached) disposeEntry(cached)
  cached = undefined
  parking?.remove()
  parking = undefined
}
if (import.meta.hot) import.meta.hot.dispose(disposeEmojiPicker)
