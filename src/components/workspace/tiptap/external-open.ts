import i18n from "@/lib/i18n"
import { errorType, logger } from "@/lib/logger"
import { fetchPageInfo, openAttachment, openWebAddress, type PageInfo } from "@/lib/storage"
import { useAppNoticesStore } from "../notices/use-app-notices-store"

// The backend decides what may be opened and answers with one of these codes; the person
// sees a sentence about it, never the code or a path.
const MESSAGES: Array<[code: string, key: string]> = [
  ["AttachmentNotFound", "externalOpen.attachmentNotFound"],
  ["AttachmentOutsideAssets", "externalOpen.attachmentOutsideAssets"],
  ["AttachmentTypeNotAllowed", "externalOpen.attachmentTypeNotAllowed"],
  ["AddressNotAllowed", "externalOpen.addressNotAllowed"],
  ["AttachmentOpenUnavailable", "externalOpen.unavailable"],
  ["FetchUnavailable", "externalOpen.unavailable"],
  ["PrivateAddress", "externalOpen.privateAddress"],
  ["TooManyRedirects", "externalOpen.tooManyRedirects"],
  ["PageNotHtml", "externalOpen.pageNotHtml"],
  ["PageBadStatus", "externalOpen.pageBadStatus"],
  ["PageEncodingUnsupported", "externalOpen.pageEncoding"],
  ["PageHasNoTitle", "externalOpen.pageNoTitle"],
  ["PageNetworkFailed", "externalOpen.pageNetwork"],
  ["PageTimeout", "externalOpen.pageTimeout"],
]

/** The key of the sentence that explains a refusal in words. */
export function openErrorKey(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const match = MESSAGES.find(([code]) => text.includes(code))
  return match ? match[1] : "externalOpen.openFailed"
}

export function openErrorMessage(error: unknown): string {
  return i18n.t(openErrorKey(error))
}

/**
 * A refusal to open or save something outside the note. Nothing is lost and nobody waits for an answer, so it
 * is a warning in the notification centre (docs/notices.md, sections 2.1 and 3), in words; the code of the
 * refusal goes to the log.
 */
export function reportExternalFailure(error: unknown): void {
  logger.warn("external_open.refused", { errorType: errorType(error) })
  const titleKey = openErrorKey(error)
  useAppNoticesStore.getState().post({
    id: `external-open:${titleKey}`,
    level: "warning",
    titleKey,
    lineKey: "notices.app.nothingChanged",
  })
}

/** The path of an attachment without the `#page=3` or `?t=5` that may follow its name. */
export function attachmentFilePath(address: string): string {
  return address.split(/[?#]/u, 1)[0] ?? address
}

/** The person's click on an attachment: the file is opened by the system, if it may be. */
export async function openAttachmentWithSystem(notePath: string, address: string) {
  try {
    await openAttachment(notePath, attachmentFilePath(address))
  } catch (error) {
    reportExternalFailure(error)
  }
}

/** The person's click on a bookmark: the address is opened in the browser, if it may be. */
export async function openWebAddressInBrowser(address: string) {
  try {
    await openWebAddress(address)
  } catch (error) {
    reportExternalFailure(error)
  }
}

/**
 * The person's click on "fetch the title": one request to the page, made by the backend.
 * A refusal is explained to the person and gives `null`; nothing in a note changes.
 */
export async function fetchPageInfoOnce(address: string): Promise<PageInfo | null> {
  try {
    return await fetchPageInfo(address)
  } catch (error) {
    reportExternalFailure(error)
    return null
  }
}
