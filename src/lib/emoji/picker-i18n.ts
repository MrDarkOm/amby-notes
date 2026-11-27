import type { TFunction } from "i18next"

export const emojiPickerI18n = (t: TFunction) => ({
  search: t("emojiPicker.filter"),
  search_no_results_1: t("emojiPicker.noResultsTitle"),
  search_no_results_2: t("emojiPicker.noResults"),
  pick: t("emojiPicker.pick"),
  add_custom: t("emojiPicker.custom"),
  categories: {
    activity: t("emojiPicker.categories.activity"),
    custom: t("emojiPicker.categories.custom"),
    flags: t("emojiPicker.categories.flags"),
    foods: t("emojiPicker.categories.foods"),
    frequent: t("emojiPicker.categories.frequent"),
    nature: t("emojiPicker.categories.nature"),
    objects: t("emojiPicker.categories.objects"),
    people: t("emojiPicker.categories.people"),
    places: t("emojiPicker.categories.places"),
    search: t("emojiPicker.categories.search"),
    symbols: t("emojiPicker.categories.symbols"),
  },
  skins: {
    choose: t("emojiPicker.skins.choose"),
    1: t("emojiPicker.skins.default"),
    2: t("emojiPicker.skins.light"),
    3: t("emojiPicker.skins.mediumLight"),
    4: t("emojiPicker.skins.medium"),
    5: t("emojiPicker.skins.mediumDark"),
    6: t("emojiPicker.skins.dark"),
  },
})
