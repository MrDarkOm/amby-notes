import type { DossierLayout, DossierSection } from "@/lib/storage"

const todo = (): never => {
  throw new Error("not implemented")
}

export const layoutFromBody = (
  _body: string,
  _hints: ReadonlyMap<string, string>,
  _fallbackTitle = "",
): DossierLayout => todo()
export const addSection = (_layout: DossierLayout, _title: string): DossierLayout => todo()
export const moveSection = (_layout: DossierLayout, _index: number, _by: -1 | 1): DossierLayout =>
  todo()
export const updateSection = (
  _layout: DossierLayout,
  _id: string,
  _patch: Partial<Pick<DossierSection, "title" | "hint">>,
): DossierLayout => todo()
export const removeSection = (_layout: DossierLayout, _id: string): DossierLayout => todo()
export const addField = (_layout: DossierLayout, _id: string, _field: string): DossierLayout =>
  todo()
export const removeField = (_layout: DossierLayout, _id: string, _field: string): DossierLayout =>
  todo()
export const layoutHints = (_layout: DossierLayout): Map<string, string> => todo()
export const sectionOfTitle = (_layout: DossierLayout, _title: string): DossierSection | null =>
  todo()
export const fieldsOutsideSections = (
  _layout: DossierLayout | null,
  _fields: readonly string[],
): string[] => todo()
export const layoutProblem = (_layout: DossierLayout): "empty" | "title" | "duplicate" | null =>
  todo()
