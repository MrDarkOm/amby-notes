import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import sentKeys from "./interface-label-keys.json"
import { linkLabels, projectLabels, projectRequestKind } from "./project-labels"

describe("project labels", () => {
  it("names the base sections and groups in the language that is active", () => {
    const ru = projectLabels(i18n.getFixedT("ru"))
    const en = projectLabels(i18n.getFixedT("en"))
    expect(ru).toMatchObject({
      "section:stories": "Истории",
      "section:notes": "Заметки",
      "section:characters": "Персонажи",
      "section:locations": "Локации",
      "property:level": "Уровень",
      "property:parent": "Родитель",
      "property:order": "Порядок",
      "property:format": "Формат",
      "property:status": "Статус",
      "level:book": "Книга",
      "level:arc": "Арка",
      "level:chapter": "Глава",
      "level:page": "Страница",
      "format:manuscript": "Рукопись",
      "format:screenplay": "Сценарий",
      "format:comic": "Комикс",
      "format:note": "Заметка",
      "status:draft": "Черновик",
      "status:inProgress": "В работе",
      "status:done": "Готово",
    })
    expect(en["section:stories"]).toBe("Stories")
    expect(en["section:characters"]).toBe("Characters")
    expect(en["level:chapter"]).toBe("Chapter")
    expect(ru["importance:main"]).toBe("Главные")
    expect(ru["heading:biography"]).toBe("Биография")
    expect(ru["template:dossier"]).toBe("Досье")
    expect(en["preset:portrait"]).toBe("Portrait")
    expect(en["view:gallery"]).toBe("Gallery")
    expect(en["property:parent"]).toBe("Parent")
    expect(en["status:inProgress"]).toBe("In progress")
  })

  it("names the universes and the two link properties in both languages", () => {
    const ru = projectLabels(i18n.getFixedT("ru"))
    const en = projectLabels(i18n.getFixedT("en"))
    expect(ru["section:universes"]).toBe("Вселенные")
    expect(en["section:universes"]).toBe("Universes")
    expect(ru["property:stories"]).toBe("Истории")
    expect(ru["property:universe"]).toBe("Вселенная")
    expect(en["property:stories"]).toBe("Stories")
    expect(en["property:universe"]).toBe("Universe")
    // Adding the links later sends only these two.
    expect(Object.keys(linkLabels(i18n.getFixedT("en"))).sort()).toEqual([
      "property:stories",
      "property:universe",
    ])
  })

  it("sends exactly the keys the backend test feeds to every creation", () => {
    // `interface-label-keys.json` is also read by the Rust test
    // `the_labels_the_interface_sends_are_accepted_by_every_creation`, so a key added here
    // without being accepted by the real backend fails there, and vice versa.
    for (const language of ["ru", "en"]) {
      expect(Object.keys(projectLabels(i18n.getFixedT(language))).sort()).toEqual(sentKeys)
    }
  })

  it("only uses keys the backend accepts", () => {
    for (const key of Object.keys(projectLabels(i18n.getFixedT("en")))) {
      expect(key).toMatch(
        /^(section:(stories|notes|characters|locations|universes)|property:(stories|universe|level|parent|order|format|status)|level:(book|arc|chapter|page)|format:(manuscript|screenplay|comic|note)|status:(draft|inProgress|done)|preset:(importance|kind|portrait|image)|importance:(main|side|episode)|kind:(city|district|place|nature)|heading:(basic|traits|appearance|biography|description|history)|view:gallery|template:dossier)$/u,
      )
    }
  })

  it("maps what the dialog offers onto the backend kinds", () => {
    expect(projectRequestKind("story")).toEqual({ kind: "story", baseSections: true })
    expect(projectRequestKind("universe")).toEqual({ kind: "collection", baseSections: true })
    expect(projectRequestKind("collection")).toEqual({ kind: "collection", baseSections: false })
  })
})
