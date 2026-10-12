import { describe, expect, it } from "vitest"
import i18n from "@/lib/i18n"
import { projectLabels, projectRequestKind } from "./project-labels"

describe("project labels", () => {
  it("names the base sections and groups in the language that is active", () => {
    const ru = projectLabels(i18n.getFixedT("ru"))
    const en = projectLabels(i18n.getFixedT("en"))
    expect(ru).toMatchObject({
      "section:text": "Текст",
      "section:notes": "Заметки",
      "section:characters": "Персонажи",
      "section:locations": "Локации",
      "group:work": "История",
      "group:world": "Мир",
      "property:level": "Уровень",
      "property:parent": "Родитель",
      "property:order": "Порядок",
      "property:format": "Формат",
      "level:book": "Книга",
      "level:arc": "Арка",
      "level:chapter": "Глава",
      "level:page": "Страница",
      "format:manuscript": "Рукопись",
      "format:screenplay": "Сценарий",
      "format:comic": "Комикс",
      "format:note": "Заметка",
    })
    expect(en["section:text"]).toBe("Text")
    expect(en["group:world"]).toBe("World")
    expect(en["level:chapter"]).toBe("Chapter")
    expect(ru["importance:main"]).toBe("Главные")
    expect(ru["heading:biography"]).toBe("Биография")
    expect(ru["template:dossier"]).toBe("Досье")
    expect(en["preset:portrait"]).toBe("Portrait")
    expect(en["view:gallery"]).toBe("Gallery")
    expect(en["property:parent"]).toBe("Parent")
  })

  it("only uses keys the backend accepts", () => {
    for (const key of Object.keys(projectLabels(i18n.getFixedT("en")))) {
      expect(key).toMatch(
        /^(section:(text|notes|characters|locations)|group:(work|world)|property:(level|parent|order|format)|level:(book|arc|chapter|page)|format:(manuscript|screenplay|comic|note)|preset:(importance|kind|portrait|image)|importance:(main|side|episode)|kind:(city|district|place|nature)|heading:(basic|traits|appearance|biography|description|history)|view:gallery|template:dossier)$/u,
      )
    }
  })

  it("maps what the dialog offers onto the backend kinds", () => {
    expect(projectRequestKind("story")).toEqual({ kind: "story", baseSections: true })
    expect(projectRequestKind("universe")).toEqual({ kind: "collection", baseSections: true })
    expect(projectRequestKind("collection")).toEqual({ kind: "collection", baseSections: false })
  })
})
