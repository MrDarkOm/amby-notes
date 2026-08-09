import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import { localeResources } from "@/locales/resources"

export { SUPPORTED_LANGUAGES, type LanguageCode } from "@/locales/resources"

void i18n.use(initReactI18next).init({
  resources: localeResources,
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false },
})

export default i18n
