import i18n from "@/lib/i18n"
import { errorType, logger } from "@/lib/logger"
import { openAttachment, openWebAddress, showErrorMessage } from "@/lib/storage"

// The backend decides what may be opened and answers with one of these codes; the person
// sees a sentence about it, never the code or a path.
const MESSAGES: Array<[code: string, key: string]> = [
  ["AttachmentNotFound", "externalOpen.attachmentNotFound"],
  ["AttachmentOutsideAssets", "externalOpen.attachmentOutsideAssets"],
  ["AttachmentTypeNotAllowed", "externalOpen.attachmentTypeNotAllowed"],
  ["AddressNotAllowed", "externalOpen.addressNotAllowed"],
  ["AttachmentOpenUnavailable", "externalOpen.unavailable"],
]

export function openErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const match = MESSAGES.find(([code]) => text.includes(code))
  return i18n.t(match ? match[1] : "externalOpen.openFailed")
}

async function report(error: unknown) {
  logger.warn("external_open.refused", { errorType: errorType(error) })
  try {
    await showErrorMessage(openErrorMessage(error))
  } catch (dialogError) {
    logger.warn("external_open.dialog_failed", { errorType: errorType(dialogError) })
  }
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
    await report(error)
  }
}

/** The person's click on a bookmark: the address is opened in the browser, if it may be. */
export async function openWebAddressInBrowser(address: string) {
  try {
    await openWebAddress(address)
  } catch (error) {
    await report(error)
  }
}
