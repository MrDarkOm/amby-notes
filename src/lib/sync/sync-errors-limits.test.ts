// The codes of the server limits (docs/sync-plan.md, appendix Х, Х1, Х4) have their own texts in every
// language: the person sees what happened, never the raw code. Written before the texts.
import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { KNOWN_SYNC_ERROR_CODES, syncErrorKey } from "./sync-errors"

describe("the codes of the server limits (Х1, Х4)", () => {
  for (const code of ["server_storage_full", "server_busy"]) {
    it(`knows ${code} in both languages`, async () => {
      expect(KNOWN_SYNC_ERROR_CODES).toContain(code)
      expect(syncErrorKey(code)).toBe(`sync.errors.${code}`)
      for (const language of ["ru", "en"]) {
        await i18n.changeLanguage(language)
        expect(i18n.exists(`sync.errors.${code}`), `${language}: ${code}`).toBe(true)
        expect(i18n.t(`sync.errors.${code}`)).not.toMatch(/server_storage_full|server_busy/)
      }
    })
  }
})
